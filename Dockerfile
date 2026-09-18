# Imagen del servicio de limpieza de metadatos con cobro x402.
#
# Se construye desde la RAÍZ del repositorio porque el motor reutiliza el código
# del navegador tal cual: service/src/core.js importa ../../web/*.js. Si el
# contexto fuese solo service/, esos ficheros no existirían y el servicio no
# arrancaría.
#
# Desplegar:  railway up        (desde la raíz del repo)

FROM oven/bun:1

WORKDIR /app/service

# Dependencias primero, para aprovechar la caché de capas.
COPY service/package.json service/package-lock.json ./
RUN bun install --production

# El servicio y el motor del navegador que reutiliza.
COPY service ./
COPY web /app/web

# /app/web/*.js no tiene package.json propio: esta marca evita depender de que
# el runtime adivine que son módulos ES.
RUN printf '{"type":"module"}' > /app/package.json

# En un contenedor hay que escuchar en todas las interfaces: si no, el proxy de
# Railway no llega al proceso. El puerto lo inyecta Railway en $PORT.
ENV HOST=0.0.0.0
ENV PORT=8402
# El disco del contenedor es efímero: el registro de ventas va a un volumen
# montado en /data (sin volumen, se pierde en cada despliegue).
ENV LEDGER_FILE=/data/ventas.jsonl

EXPOSE 8402

CMD ["bun", "src/server.js"]
