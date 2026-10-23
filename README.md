# PDF Editor (app web para iPhone)

Editor de PDF que funciona en Safari, también sin conexión. Todo se procesa en el teléfono y los archivos no se suben a ningún servidor.

**Funciones:** escribir texto, lápiz, resaltar, firma (con firmas guardadas), tapar zonas, insertar imágenes y fotos, rellenar formularios, girar, reordenar y borrar páginas, unir varios PDF, añadir páginas en blanco, deshacer y rehacer. Si Safari cierra la app, el trabajo se recupera con «Continuar con…».

## Publicarla

Es una carpeta estática: sube **todo el contenido de `pdf-editor/`** a cualquier hosting con HTTPS (GitHub Pages, Netlify, Vercel o Cloudflare Pages). Para funcionar sin conexión necesita HTTPS.

## Instalarla en el iPhone

1. Abre la dirección en **Safari**.
2. Toca **Compartir** → **Añadir a pantalla de inicio**.
3. Ábrela una vez con internet para que quede guardada. Después funciona sin conexión.

## Actualizarla

Después de cambiar cualquier archivo, sube el número de `VERSION` en `sw.js` (por ejemplo `v1` → `v2`). Si no lo haces, los teléfonos seguirán usando la copia antigua.

## Límites

- El texto usa la fuente Helvetica del PDF. Los emojis y algunos símbolos (por ejemplo ✓) se guardan como «?».
- «Tapar» dibuja un recuadro encima. El texto que queda debajo sigue dentro del archivo, así que no sirve para borrar datos confidenciales.
- Los PDF protegidos con contraseña se guardan con sus páginas convertidas en imagen.

Librerías incluidas en `vendor/`: [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) y [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT).
