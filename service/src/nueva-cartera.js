// Genera el par de carteras de prueba para la prueba en vivo:
//   - la que PAGA (esta hay que fondearla con el faucet; necesita la clave)
//   - la que COBRA (solo hace falta la dirección: ahí llega el USDC)
//
// Uso:  npm run cartera

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const nueva = () => {
  const clave = generatePrivateKey();
  return { clave, direccion: privateKeyToAccount(clave).address };
};

const paga = nueva();
const cobra = nueva();

console.log(`
Carteras de prueba para la prueba en vivo (sin valor, no las uses para nada real)

  PAGADORA (pídele USDC de prueba al faucet)
    dirección: ${paga.direccion}
    clave    : ${paga.clave}

  COBRADORA (aquí llegarán los 0,02 USDC de la prueba)
    dirección: ${cobra.direccion}

Siguiente paso:

  1. Pide USDC de prueba (gratis, sin tarjeta) para la PAGADORA:
       https://faucet.circle.com/    →    red "Base Sepolia"    →    ${paga.direccion}

  2. Cuando el faucet confirme, pega esto en esta misma ventana:

       set EVM_PRIVATE_KEY=${paga.clave}
       set X402_PAY_TO=${cobra.direccion}
       npm run prueba:testnet

  (en PowerShell: $env:EVM_PRIVATE_KEY="..." y $env:X402_PAY_TO="...")

  Si el guion te dice que la pagadora no tiene saldo, el faucet aún no ha
  acreditado: espera un minuto y repite el paso 2.
`);
