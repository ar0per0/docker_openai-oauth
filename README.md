# openai-oauth en Docker

Imagen para ejecutar [`openai-oauth`](https://github.com/EvanZhouDev/openai-oauth)
con login mediante device-auth o navegador.

La imagen incluye Node.js 22, la versión más reciente de `@openai/codex`
disponible durante la construcción, `openai-oauth` 2.0.0, `curl` y los
certificados CA. `curl` es necesario para que `codex login --device-auth`
pueda completar el flujo de código de dispositivo dentro del contenedor.

## Inicio rápido

docker-compose.yaml
```yaml
services:
  openai-oauth:
    build: .
    image: ar0per0/openai-oauth:latest
    init: true
    restart: unless-stopped
    network_mode: host
    environment:
      LOGIN_MODE: device # Cambiar a "browser" para iniciar sesión mediante el navegador.
      PORT: 10531
      TZ: Europe/Madrid # Modelo usado por las pruebas cron y de inicio; vacío usa el primero de /v1/models.
      MODEL_TEST: "gpt-6.1-sol" # Modelo usado por las pruebas cron y de inicio; vacío usa el primero de /v1/models.
      CRON_TEST: "" # Varios horarios se separan con: 5 4 * * * | 2 4 * * *
      CRON_TEST_COUNT: 3 # Número total de respuestas OK consecutivas exigidas en cada ejecución.
      STARTUP_MODEL_TEST: true # Ejecuta las mismas pruebas al arrancar si auth.json ya existía.
      HEALTHCHECK_TIMEOUT_MS: 30000 # Tiempo máximo de cada petición de prueba, tanto cron como de inicio.
    volumes:
      - openai-oauth-data:/data/codex

volumes:
  openai-oauth-data:
```
docker compose up -d `crear + iniciar docker`

docker compose -f openai-oauth `ver logs`

Captura modo device:
![Captura](./docker-openai-oauth.png)

Captura modo browser:
![Captura](./docker-openai-oauth_browser.png)

---

## Detalle


```bash
docker compose build --no-cache
```

Durante la construcción se comprueba que `curl`, `codex` y `openai-oauth`
estén instalados y sean ejecutables. El contexto Docker excluye archivos de
credenciales, `.env`, datos locales y dependencias de Node.

La imagen aplica además un parche de compatibilidad a `openai-oauth` 2.0.0
para aceptar imágenes OpenAI embebidas como
`data:image/...;base64,...` dentro de `messages[].content[].image_url`. Esa
versión convierte todas las imágenes en objetos `URL`, lo que hace que AI SDK
intente descargar también las URL `data:` y las rechace por no usar HTTP(S).
El parche entrega el contenido base64 y su tipo MIME directamente a AI SDK;
las imágenes con URL `http://` o `https://` conservan el comportamiento
original. La construcción falla explícitamente si el código de una futura
versión deja de coincidir con el parche, en vez de producir silenciosamente
una imagen sin soporte multimodal.

En `compose.yaml`, selecciona el método de autenticación:

```yaml
environment:
  LOGIN_MODE: device
```

o:

```yaml
environment:
  LOGIN_MODE: browser
```

También puedes asignar un puerto diferente a cada instancia:

```yaml
environment:
  LOGIN_MODE: device
  PORT: 10532
```

Con `network_mode: host` no debe añadirse `ports`: el servicio escuchará
directamente en `127.0.0.1` y en el puerto indicado. Cada instancia debe usar
un puerto distinto. Los primeros login mediante navegador deben realizarse de
uno en uno, porque el callback OAuth siempre utiliza el puerto `1455`.

## Modelo y comprobación programada

Estas opciones son opcionales y se configuran dentro de `compose.yaml`:

```yaml
environment:
  LOGIN_MODE: device
  PORT: 10531
  TZ: Europe/Madrid
  MODEL_TEST: gpt-5.6-luna
  CRON_TEST: "5 4 * * * | 2 4 * * * | 3 4 * * *"
  CRON_TEST_COUNT: 3
  STARTUP_MODEL_TEST: true
  HEALTHCHECK_TIMEOUT_MS: 30000
```

`MODEL_TEST` solo selecciona el modelo usado por la prueba; no restringe los
modelos publicados por el proxy. `CRON_TEST` programa una petición de prueba
al endpoint local. Se pueden indicar varias expresiones separadas por `|`; el
ejemplo ejecuta la prueba diariamente a las 04:05, 04:02 y 04:03. El resultado
aparece en `docker compose logs`. Si se configura el cron dejando
`MODEL_TEST` vacío, la prueba utiliza el primer modelo devuelto por
`/v1/models`. Para desactivarla, deja `CRON_TEST: ""`.
Cada petición genera una operación aritmética aleatoria y su resultado
esperado. Las operaciones pueden combinar suma, resta, multiplicación y
división exacta. No se repite ninguna operación dentro de una misma batería de
pruebas. La ejecución solo se considera correcta si el modelo verifica el cálculo
y devuelve exactamente `OK`; una respuesta distinta o vacía se registra como
`ERROR`.
`CRON_TEST_COUNT` indica cuántas peticiones consecutivas deben responder
exactamente `OK` antes de registrar el resultado como correcto. Su valor debe
ser un entero entre 1 y 100 y, si se omite, se utiliza `1`. Por ejemplo, con
`CRON_TEST_COUNT: 3` se realizan tres peticiones secuenciales; si cualquiera
falla, no se ejecutan las restantes y el log identifica la comprobación que
falló, como `Comprobación 2/3`. Solo después de superar las tres aparece un
único resultado final con `checks=3 response="OK"`.
Cada comprobación consume una petición real del modelo. El timeout configurado
se aplica por separado a cada petición, por lo que una ejecución completa puede
durar como máximo aproximadamente `CRON_TEST_COUNT × HEALTHCHECK_TIMEOUT_MS`
cuando `MODEL_TEST` está definido. Si `MODEL_TEST` está vacío, antes de las
comprobaciones se realiza una petición adicional a `/v1/models`; en ese caso,
el máximo teórico es aproximadamente
`(CRON_TEST_COUNT + 1) × HEALTHCHECK_TIMEOUT_MS`.
Con `STARTUP_MODEL_TEST: true`, el contenedor también ejecuta esta batería una
vez después de que el endpoint local esté disponible. Solo se ejecuta cuando
`auth.json` ya existía y no estaba vacío antes de iniciar el contenedor; si el
arranque crea las credenciales mediante un nuevo login, la prueba se omite hasta
el próximo reinicio. El resultado utiliza la etiqueta `[openai-oauth][startup]`
y un fallo queda registrado sin detener ni reiniciar el servicio. Con `false`,
que es el valor predeterminado de la imagen, esta comprobación queda desactivada.
La expresión se interpreta usando la zona horaria indicada en `TZ`.
`TZ` debe ser una zona IANA instalada, como `Europe/Madrid`. Las expresiones
cron se validan antes de iniciar el servicio, incluidos los rangos permitidos
para minuto, hora, día, mes y día de la semana.
La marca horaria escrita por la prueba también utiliza esa zona, por ejemplo
`2026-09-18 16:04:03`. Ten en cuenta que
`docker logs --timestamps` añade por separado una marca de Docker terminada en
`Z`; esa marca externa siempre está expresada en UTC.
Cada petición se cancela después de `HEALTHCHECK_TIMEOUT_MS` milisegundos para
evitar procesos cron bloqueados. Además, Docker comprueba `/health` cada 30
segundos sin consumir una petición de modelo; su estado puede consultarse con
`docker compose ps`.

## Primer arranque

Es conveniente ejecutar el primer inicio adjunto a la terminal para ver las
instrucciones del login:

```bash
docker compose up
```

- `device`: muestra el flujo de device-auth de Codex.
- `browser`: imprime una URL. Ábrela manualmente en el navegador del mismo
  equipo. No se intenta abrir un navegador dentro del contenedor.

Después del login, las credenciales quedan guardadas en el volumen
`openai-oauth-data` y el proxy queda disponible en:

```text
http://127.0.0.1:10531/v1
```

Los siguientes arranques omiten el login automáticamente. Para dejarlo en
segundo plano:

```bash
docker compose up -d
docker compose logs -f
```

## Servidor Docker remoto

Para `LOGIN_MODE=browser`, abre desde tu ordenador un túnel antes del primer
arranque:

```bash
ssh -L 1455:127.0.0.1:1455 usuario@servidor
```

Mantén el túnel abierto, ejecuta `docker compose up` en el servidor y abre en
tu navegador local la URL impresa por el contenedor.

## Publicar la imagen

```bash
docker compose build
docker login
docker compose push
```

## Reiniciar las credenciales

Primero detén el servicio. El siguiente comando elimina exclusivamente el
volumen de este proyecto y obliga a repetir el login:

```bash
docker compose down -v
```

## Seguridad

La configuración predeterminada enlaza el proxy a `127.0.0.1`. No cambies
`HOST` a `0.0.0.0` en una máquina accesible desde Internet sin colocar delante
autenticación y TLS.
