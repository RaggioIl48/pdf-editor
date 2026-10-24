# PDF Editor (app web para iPhone)

Editor de PDF que funciona en Safari, también sin conexión. Todo se procesa en el teléfono y los archivos no se suben a ningún servidor.

**Crear PDF desde imágenes:** elige fotos de la galería o tómalas con la cámara, ordénalas y gíralas, y elige el tamaño de página (A4, Carta o igual a la imagen), los márgenes, un filtro de escáner (documento en gris nítido o blanco y negro) y la calidad. El PDF se abre en el editor para seguir trabajando. Desde «Páginas → + Imágenes» también puedes añadir fotos a un PDF que ya tengas abierto.

**Editar el texto del PDF:** con la herramienta «Editar» las líneas de texto del PDF se marcan en azul. Toca una, cámbiala (o déjala vacía para borrarla) y la app la reemplaza en la misma posición, tamaño y color, con la fuente estándar más parecida (Helvetica, Times o Courier, en negrita o cursiva si corresponde). El texto original queda tapado por debajo, igual que hacen la mayoría de editores en el móvil.

**Funciones de edición:** escribir texto, lápiz, resaltar, firma (con firmas guardadas), tapar zonas, insertar imágenes y fotos, rellenar formularios, girar, reordenar y borrar páginas, unir varios PDF, añadir páginas en blanco, deshacer y rehacer. Si Safari cierra la app, el trabajo se recupera con «Continuar con…».

## Publicarla

Es una carpeta estática: sube **todo el contenido de `pdf-editor/`** a cualquier hosting con HTTPS (GitHub Pages, Netlify, Vercel o Cloudflare Pages). Para funcionar sin conexión necesita HTTPS.

## Instalarla

- **iPhone:** abre la dirección en **Safari** → **Compartir** → **Añadir a pantalla de inicio**.
- **Android:** abre la dirección en **Chrome** → menú **⋮** → **Instalar app** (o **Añadir a pantalla de inicio**).

Ábrela una vez con internet para que quede guardada. Después funciona sin conexión. El botón «Compartir esta app con amigos» de la pantalla de inicio envía el enlace por WhatsApp, correo, etc.

## Actualizarla

Después de cambiar cualquier archivo, sube el número de `VERSION` en `sw.js` (por ejemplo `v1` → `v2`). Si no lo haces, los teléfonos seguirán usando la copia antigua.

## Límites

- El texto usa la fuente Helvetica del PDF. Los emojis y algunos símbolos (por ejemplo ✓) se guardan como «?».
- «Editar» no modifica el texto original dentro del archivo: lo tapa y escribe el nuevo encima. Si alguien copia o busca texto en el PDF, todavía puede encontrar el texto anterior. Las páginas escaneadas o fotos no tienen texto editable.
- «Tapar» dibuja un recuadro encima. El texto que queda debajo sigue dentro del archivo, así que no sirve para borrar datos confidenciales.
- Los PDF protegidos con contraseña se guardan con sus páginas convertidas en imagen.

Librerías incluidas en `vendor/`: [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) y [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT).
