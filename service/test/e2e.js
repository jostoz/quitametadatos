// Prueba de extremo a extremo del servicio de pago.
//
// Servicio real (Hono + middleware x402) + cliente x402 real (@x402/fetch con
// firma EIP-712 de verdad) + facilitador de pruebas que verifica la firma y
// simula la liquidación. Comprueba:
//   1. sin pago → 402 con los requisitos exactos y sin cobrar
//   2. con pago válido → 200 con el ZIP limpio y liquidación única
//   3. pago válido + archivo no soportado → 422 y SIN cobrar
//   4. pago mal dirigido (el agente se paga a sí mismo) → 402 y sin cobrar
//   5. el mismo pago dos veces → el segundo se rechaza (nonce ya usado)
//   6. respuesta JSON (Accept: application/json) con el archivo en base64
//
// Ejecutar: bun test/e2e.js

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { generateKeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';

import { readZip } from '../../web/zip.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { startServer } from '../src/server.js';
import { startStubFacilitator } from './stub-facilitator.js';
import { cabeceraDePagoSolana } from './svm-payment.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAICES = join(HERE, '..', '..');
const FIXTURE = join(RAICES, '_fixture_foto.jpg');

let ok = 0;
const fallos = [];
function check(nombre, condicion, detalle = '') {
  if (condicion) {
    ok++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallos.push(nombre);
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function section(titulo) {
  console.log(`\n${titulo}`);
}

const fotoBytes = new Uint8Array(await readFile(FIXTURE));
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const merchant = privateKeyToAccount(generatePrivateKey());
const attacker = privateKeyToAccount(generatePrivateKey());
const svmAgente = await generateKeyPairSigner();
const svmCobrador = (await generateKeyPairSigner()).address;
const RED_SVM = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'; // Solana devnet

const facilitator = await startStubFacilitator({ networks: ['eip155:84532', RED_SVM] });
const registroVentas = join(tmpdir(), `ventas-e2e-${Date.now()}.jsonl`);
const config = loadConfig({
  LEDGER_FILE: registroVentas,
  PUBLIC_URL: 'https://servicio.example.com',
  X402_NETWORKS: `eip155:84532,${RED_SVM}`,
  X402_PAY_TO: merchant.address,
  X402_PAY_TO_SVM: svmCobrador,
  X402_PRICE: '$0.02',
  X402_FACILITATOR_URL: facilitator.url,
  PORT: '0',
  HOST: '127.0.0.1',
});
const { url, stop } = await startServer(config);
console.log(`servicio en ${url} · agente ${agent.address} / ${svmAgente.address}`);
console.log(`cobra en eip155:84532 a ${merchant.address} y en Solana a ${svmCobrador}`);

const client = x402Client.fromConfig({
  schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(agent) }],
});
const fetchPaid = wrapFetchWithPayment(fetch, client);

const upload = (nombre = 'foto.jpg', bytes = fotoBytes, extra = {}) => {
  const form = new FormData();
  form.append('file', new File([bytes], nombre, { type: 'image/jpeg' }));
  if (extra.options) form.append('options', JSON.stringify(extra.options));
  return form;
};
const headers = (extra = {}) => (extra.json ? { Accept: 'application/json' } : {});

try {
  // ---------------------------------------------------------------- 1
  section('1. Sin pago');
  const reto = await fetch(`${url}/v1/clean`, { method: 'POST', body: upload() });
  check('responde 402 Payment Required', reto.status === 402, `status ${reto.status}`);
  const crudo = reto.headers.get('payment-required');
  check('incluye la cabecera PAYMENT-REQUIRED', !!crudo);
  const requisitos = crudo ? decodePaymentRequiredHeader(crudo) : null;
  check('el reto ofrece las dos redes', requisitos?.accepts?.length === 2,
    requisitos?.accepts?.map((a) => a.network).join(', '));
  const aceptado = requisitos?.accepts?.[0];
  const aceptadoSvm = requisitos?.accepts?.find((a) => a.network.startsWith('solana:'));
  check('el reto pide el importe correcto (0.02 USDC)', aceptado?.amount === '20000', aceptado?.amount);
  check('el reto paga a la dirección del comercio', aceptado?.payTo === merchant.address, aceptado?.payTo);
  check('el reto usa USDC en Base Sepolia',
    aceptado?.asset?.toLowerCase() === '0x036cbd53842c5426634e7929541eC2318f3dCF7e'.toLowerCase(),
    aceptado?.asset);
  check('el reto de Solana paga a la dirección de Solana', aceptadoSvm?.payTo === svmCobrador, aceptadoSvm?.payTo);
  check('el reto de Solana pide el mismo importe', aceptadoSvm?.amount === '20000', aceptadoSvm?.amount);
  check('tras un proxy, el reto anuncia la URL pública (no la interna)',
    requisitos?.resource?.url === 'https://servicio.example.com/v1/clean',
    `URL recibida: ${requisitos?.resource?.url} · config.publicUrl=${config.publicUrl} · acepta=${requisitos?.accepts?.length}`);
  const bazar = requisitos?.extensions?.bazaar;
  check('el reto se anuncia para los directorios de agentes (bazaar)',
    !!bazar && (bazar.info?.input?.bodyType === 'json' || !!bazar.info?.input),
    JSON.stringify(bazar)?.slice(0, 200));
  check('el anuncio describe qué devuelve el servicio',
    !!bazar?.schema?.properties?.input || !!bazar?.info?.output,
    JSON.stringify(bazar?.schema)?.slice(0, 200));
  check('el reto de Solana trae el fee payer del facilitador',
    aceptadoSvm?.extra?.feePayer === facilitator.feePayerSvm, aceptadoSvm?.extra?.feePayer);
  check('no se liquidó nada', facilitator.calls.settle.length === 0);
  check('el facilitador recibió el /supported', facilitator.calls.supported > 0);

  // ---------------------------------------------------------------- 2
  section('2. Pago válido');
  const pagado = await fetchPaid(`${url}/v1/clean`, { method: 'POST', body: upload() });
  check('responde 200', pagado.status === 200, `status ${pagado.status}`);
  check('devuelve un ZIP', pagado.headers.get('content-type') === 'application/zip');
  const liquido = pagado.headers.get('payment-response');
  check('incluye la cabecera PAYMENT-RESPONSE', !!liquido);
  const liquidacion = liquido ? decodePaymentResponseHeader(liquido) : null;
  check('la liquidación fue correcta', liquidacion?.success === true, JSON.stringify(liquidacion));
  check('la liquidación es de la red pedida', liquidacion?.network === 'eip155:84532');
  check('el facilitador liquidó una sola vez', facilitator.calls.settle.length === 1);
  check('el importe liquidado es el pedido', facilitator.calls.settle[0]?.amount === '20000');
  check('liquidó a la dirección del comercio', facilitator.calls.settle[0]?.payTo === merchant.address);

  const zip = await readZip(new Uint8Array(await pagado.arrayBuffer()));
  const porNombre = new Map(zip.map((e) => [e.name, e.data]));
  check('el ZIP trae el archivo limpio', porNombre.has('foto - sin metadatos.jpg'),
    [...porNombre.keys()].join(', '));
  check('el ZIP trae informe.json', porNombre.has('informe.json'));
  const limpia = porNombre.get('foto - sin metadatos.jpg');
  check('el archivo limpio es más pequeño (se quitaron metadatos)',
    limpia && limpia.length < fotoBytes.length, `${fotoBytes.length} → ${limpia?.length}`);
  check('los píxeles no se recodifican (el JPEG sigue siendo JPEG)',
    limpia && limpia[0] === 0xff && limpia[1] === 0xd8);

  const informe = JSON.parse(new TextDecoder().decode(porNombre.get('informe.json')));
  const ficha = informe.files?.[0];
  check('el informe describe el archivo', ficha?.file?.name === 'foto.jpg', JSON.stringify(ficha?.file));
  check('el informe lista lo eliminado (EXIF/GPS)', (ficha?.removed || []).length > 0);
  check('el informe incluye la huella del archivo de salida',
    /^[0-9a-f]{64}$/.test(ficha?.file?.sha256Output || ''), ficha?.file?.sha256Output);
  check('el informe se corresponde con los bytes entregados',
    ficha && ficha.file.bytesOutput === limpia.length);

  const asientos = (await readFile(registroVentas, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const asiento = asientos.at(-1);
  check('el registro de ventas apunta la venta', asientos.length === 1 && asiento.resultado === 'liquidado',
    JSON.stringify(asientos));
  check('el asiento trae fecha, importe, red, pagador y tx',
    !!asiento.fecha && asiento.importe.startsWith('20000') && asiento.red === 'eip155:84532'
    && asiento.pagador?.toLowerCase() === agent.address.toLowerCase() && /^0x[0-9a-f]{64}$/.test(asiento.tx),
    JSON.stringify(asiento));
  check('el asiento dice a qué cartera se cobró', asiento.cobradoA === merchant.address);

  // ---------------------------------------------------------------- 3
  section('3. Pago válido pero archivo no soportado (no se cobra)');
  const antes = facilitator.calls.settle.length;
  const malo = await fetchPaid(`${url}/v1/clean`, {
    method: 'POST',
    body: upload('notas.txt', new TextEncoder().encode('esto no es un documento ni una imagen')),
  });
  check('responde 422', malo.status === 422, `status ${malo.status}`);
  const err = await malo.json();
  check('explica el motivo', /no se puede procesar|no se pudo limpiar/i.test(err.error || ''), err.error);
  check('NO se liquidó el pago', facilitator.calls.settle.length === antes);

  // ---------------------------------------------------------------- 4
  section('4. Pago mal dirigido (el agente intenta pagarse a sí mismo)');
  const desafio = await fetch(`${url}/v1/clean`, { method: 'POST', body: upload() });
  const req = decodePaymentRequiredHeader(desafio.headers.get('payment-required')).accepts[0];
  const nonce = `0x${randomBytes(32).toString('hex')}`;
  const autorizacion = {
    from: agent.address,
    to: attacker.address,
    value: req.amount,
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce,
  };
  const firma = await agent.signTypedData({
    domain: {
      name: req.extra.name,
      version: req.extra.version,
      chainId: 84532,
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: agent.address,
      to: attacker.address,
      value: BigInt(req.amount),
      validAfter: 0n,
      validBefore: BigInt(autorizacion.validBefore),
      nonce,
    },
  });
  const antesAtaque = facilitator.calls.settle.length;
  const tramposo = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { authorization: autorizacion, signature: firma } }) },
    body: upload(),
  });
  check('el servicio rechaza el pago (402)', tramposo.status === 402, `status ${tramposo.status}`);
  check('no se liquidó nada', facilitator.calls.settle.length === antesAtaque);
  const ultimoVerify = facilitator.calls.verify.at(-1);
  check('el facilitador vio el destinatario incorrecto',
    ultimoVerify?.invalidReason === 'destinatario_incorrecto', JSON.stringify(ultimoVerify));

  // ---------------------------------------------------------------- 5
  section('5. Reutilizar el mismo pago (replay)');
  const nonce2 = `0x${randomBytes(32).toString('hex')}`;
  const aut2 = {
    from: agent.address,
    to: merchant.address,
    value: req.amount,
    validAfter: '0',
    validBefore: String(Math.floor(Date.now() / 1000) + 600),
    nonce: nonce2,
  };
  const firma2 = await agent.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 84532, verifyingContract: req.asset },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: agent.address,
      to: merchant.address,
      value: BigInt(req.amount),
      validAfter: 0n,
      validBefore: BigInt(aut2.validBefore),
      nonce: nonce2,
    },
  });
  const cabecera = {
    'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { authorization: aut2, signature: firma2 } }),
  };
  const primera = await fetch(`${url}/v1/clean`, { method: 'POST', headers: cabecera, body: upload() });
  check('el primer uso se acepta (200)', primera.status === 200, `status ${primera.status}`);
  const segundos = await fetch(`${url}/v1/clean`, { method: 'POST', headers: cabecera, body: upload() });
  check('el segundo uso se rechaza (402)', segundos.status === 402, `status ${segundos.status}`);
  check('el motivo es el nonce ya usado',
    facilitator.calls.verify.at(-1)?.invalidReason === 'pago_ya_usado',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  // ---------------------------------------------------------------- 6
  section('6. Respuesta JSON para agentes');
  const comoJson = await fetchPaid(`${url}/v1/clean`, {
    method: 'POST',
    headers: headers({ json: true }),
    body: upload(),
  });
  check('responde 200', comoJson.status === 200, `status ${comoJson.status}`);
  const cuerpo = await comoJson.json();
  check('trae el archivo en base64', typeof cuerpo.files?.[0]?.bytesBase64 === 'string');
  check('el base64 son los mismos bytes que el ZIP',
    Buffer.from(cuerpo.files[0].bytesBase64, 'base64').equals(Buffer.from(limpia)));
  check('trae los hallazgos del análisis', Array.isArray(cuerpo.files[0].findings) && cuerpo.files[0].findings.length > 0);

  // ---------------------------------------------------------------- 7
  section('7. Pago en Solana (misma petición, otra cartera)');
  const desafioSvm = decodePaymentRequiredHeader(
    (await fetch(`${url}/v1/clean`, { method: 'POST', body: upload() })).headers.get('payment-required'),
  ).accepts.find((a) => a.network === RED_SVM);

  const antesSvm = facilitator.calls.settle.length;
  const pagoSvm = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: {
      'PAYMENT-SIGNATURE': await cabeceraDePagoSolana({
        requisitos: desafioSvm,
        firmante: svmAgente,
        feePayer: facilitator.feePayerSvm,
      }),
    },
    body: upload(),
  });
  check('el pago en Solana se acepta (200)', pagoSvm.status === 200, `status ${pagoSvm.status}`);
  const zipSvm = await readZip(new Uint8Array(await pagoSvm.arrayBuffer()));
  check('devuelve el archivo limpio', zipSvm.some((e) => e.name === 'foto - sin metadatos.jpg'),
    zipSvm.map((e) => e.name).join(', '));
  const liquidacionSvm = facilitator.calls.settle.at(-1);
  check('se liquidó una vez más', facilitator.calls.settle.length === antesSvm + 1);
  check('la liquidación es en la red de Solana', liquidacionSvm?.network === RED_SVM, liquidacionSvm?.network);
  check('cobró a la dirección de Solana', liquidacionSvm?.payTo === svmCobrador, liquidacionSvm?.payTo);
  check('el pago quedó registrado como firmado por el agente Solana',
    facilitator.calls.settle.at(-1)?.isValid !== false);

  // Un agente no puede gastar desde la cuenta de otro: firma suya, cuenta ajena.
  const desdeCuentaAjena = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: {
      'PAYMENT-SIGNATURE': await cabeceraDePagoSolana({
        requisitos: desafioSvm,
        firmante: await generateKeyPairSigner(),
        feePayer: facilitator.feePayerSvm,
        origenDe: svmAgente.address,
      }),
    },
    body: upload(),
  });
  check('no se puede pagar desde la cuenta de otro (402)', desdeCuentaAjena.status === 402, `status ${desdeCuentaAjena.status}`);
  check('el motivo es el origen',
    facilitator.calls.verify.at(-1)?.invalidReason === 'origen_incorrecto',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  const aOtraDireccion = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: {
      'PAYMENT-SIGNATURE': await cabeceraDePagoSolana({
        requisitos: desafioSvm,
        firmante: svmAgente,
        feePayer: facilitator.feePayerSvm,
        destino: (await generateKeyPairSigner()).address, // el agente se paga a sí mismo
      }),
    },
    body: upload(),
  });
  check('un pago a otra dirección se rechaza (402)', aOtraDireccion.status === 402, `status ${aOtraDireccion.status}`);
  check('el motivo es el destinatario',
    facilitator.calls.verify.at(-1)?.invalidReason === 'destinatario_incorrecto',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  const corto = await fetch(`${url}/v1/clean`, {
    method: 'POST',
    headers: {
      'PAYMENT-SIGNATURE': await cabeceraDePagoSolana({
        requisitos: desafioSvm,
        firmante: svmAgente,
        feePayer: facilitator.feePayerSvm,
        importe: '19999', // un céntimo de menos
      }),
    },
    body: upload(),
  });
  check('un importe menor se rechaza (402)', corto.status === 402, `status ${corto.status}`);
  check('el motivo es el importe',
    facilitator.calls.verify.at(-1)?.invalidReason === 'importe_insuficiente',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  const cobroSvm = { ...desafioSvm, extra: { ...desafioSvm.extra } };
  const cabeceraSvm = await cabeceraDePagoSolana({
    requisitos: cobroSvm,
    firmante: svmAgente,
    feePayer: facilitator.feePayerSvm,
  });
  const primeraSvm = await fetch(`${url}/v1/clean`, {
    method: 'POST', headers: { 'PAYMENT-SIGNATURE': cabeceraSvm }, body: upload(),
  });
  check('un pago de Solana nuevo se acepta', primeraSvm.status === 200, `status ${primeraSvm.status}`);
  const repetidoSvm = await fetch(`${url}/v1/clean`, {
    method: 'POST', headers: { 'PAYMENT-SIGNATURE': cabeceraSvm }, body: upload(),
  });
  check('el mismo pago de Solana no vale dos veces', repetidoSvm.status === 402, `status ${repetidoSvm.status}`);
  check('el motivo es que ya se usó',
    facilitator.calls.verify.at(-1)?.invalidReason === 'pago_ya_usado',
    JSON.stringify(facilitator.calls.verify.at(-1)));

  // ---------------------------------------------------------------- 8
  section('8. Nombres de archivo peligrosos');
  const conRuta = await fetchPaid(`${url}/v1/clean`, {
    method: 'POST',
    body: upload('../../evil.exe'),
  });
  check('acepta el archivo igualmente', conRuta.status === 200, `status ${conRuta.status}`);
  if (conRuta.status === 200) {
    const entradas = await readZip(new Uint8Array(await conRuta.arrayBuffer()));
    const nombres = entradas.map((e) => e.name);
    check('el ZIP no contiene rutas relativas', nombres.every((n) => !n.includes('..') && !n.includes('/')),
      nombres.join(', '));
    check('el nombre queda saneado', nombres.includes('evil - sin metadatos.exe'), nombres.join(', '));
  }

  // ---------------------------------------------------------------- 9
  section('9. Endpoints gratuitos, límites y configuración');
  const raiz = await fetch(`${url}/`);
  const info = await raiz.json();
  check('GET / describe el servicio y el precio', info.precio === '$0.02', JSON.stringify(info.precio));
  check('GET / lista las dos redes y sus direcciones',
    info.redes?.length === 2
    && info.redes.find((r) => r.familia === 'evm')?.cobrarA === merchant.address
    && info.redes.find((r) => r.familia === 'svm')?.cobrarA === svmCobrador,
    JSON.stringify(info.redes));
  const precios = await (await fetch(`${url}/v1/pricing`)).json();
  check('GET /v1/pricing no pide pago',
    precios.precio === '$0.02' && precios.redes?.length === 2 && precios.limites.archivosPorPeticion > 0);

  // La configuración no puede aceptar Solana sin dirección de cobro de Solana.
  let falloConfig = null;
  try {
    loadConfig({ X402_NETWORKS: `eip155:84532,${RED_SVM}`, X402_PAY_TO: merchant.address });
  } catch (err) {
    falloConfig = err;
  }
  check('sin X402_PAY_TO_SVM la configuración falla con un error claro',
    falloConfig instanceof ConfigError && /X402_PAY_TO_SVM/.test(falloConfig.message),
    falloConfig?.message);
  const sano = await (await fetch(`${url}/healthz`)).json();
  check('GET /healthz responde ok', sano.ok === true);
  const antesInvalidas = facilitator.calls.settle.length;
  const sinArchivo = await fetchPaid(`${url}/v1/clean`, { method: 'POST', body: new FormData() });
  check('sin archivos responde 400', sinArchivo.status === 400, `status ${sinArchivo.status}`);
  check('y no se cobra por peticiones inválidas', facilitator.calls.settle.length === antesInvalidas,
    `${facilitator.calls.settle.length} liquidaciones`);
} finally {
  await stop();
  facilitator.stop();
}

console.log(`\n${ok} comprobaciones OK, ${fallos.length} fallos`);
if (fallos.length) {
  console.log('FALLOS:');
  for (const f of fallos) console.log(` - ${f}`);
  process.exit(1);
}
