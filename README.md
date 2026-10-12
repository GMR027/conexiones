# Conexiones

Conecta páginas de ayuda, librerías, registros de paquetes, iconos, imágenes y servidores MCP; guarda lo que lee **en tu equipo** y deja que la IA (local con Ollama, o por API) responda a tus preguntas usando solo eso. Funciona en VS Code y VSCodium.

## Cómo se usa

1. **Conexiones →** pega un enlace (por ejemplo `https://packagist.org/`) y pulsa *Analizar*. Verás qué tipo de sitio es y qué se hará; si todo está bien, *Conectar*.
2. **Asistente →** pregunta con tus palabras: «¿hay algo para enviar correos en PHP?». Busca en lo guardado (y en los registros de paquetes conectados), tiene en cuenta el tipo de proyecto que tienes abierto y responde con el código, cómo instalarlo y de dónde sale cada dato.

| Pestaña | Para qué sirve |
|---|---|
| **Asistente** | Preguntas y respuestas con citas. Sin IA lista, muestra los fragmentos más relevantes. Un indicador sobre la pregunta cambia de color mientras lee y queda en verde neón cuando la respuesta está lista. Los bloques de código se pueden copiar o insertar en el cursor del editor, siempre tras una ventana **Preview** que muestra dónde y qué se insertará (nada se escribe hasta confirmar). |
| **Conexiones** | Alta, actualización, pausa y baja de conexiones. |
| **Biblioteca** | Lo guardado (páginas y paquetes), búsqueda sin conexión y búsqueda de paquetes en Packagist/npm con «Guardar en mi biblioteca». |
| **Recursos** | Buscador de iconos (Font Awesome gratis: copiar `<i>`, clases, SVG o nombre), de fuentes (Google Fonts: copiar `<link>`, `@import`, CSS o `npm`) y de imágenes (Unsplash, Pexels u Openverse: **guardar en la carpeta del proyecto**, o copiar `<img>`, CSS, URL o crédito). |
| **Estado** | Semáforo de cada conexión, servidores MCP (activo, falta la clave, inactivo…) y espacio usado. |
| **Ajustes** | Seguridad, sincronización, almacenamiento, búsqueda e idioma. |

## Modo Kraken

Un botón bajo «IA local / API». Al encenderlo, el panel se rodea de un contorno neón y la IA que tengas activa:

1. **Lee el proyecto completo** (tipo, estructura, dependencias y fragmentos de código; nunca `.env`, claves ni bases de datos, y las claves que aparezcan en el código se tapan antes de enviarlas).
2. **Busca y conecta sola** las webs que te sirven: un catálogo según tu stack (Laravel, React, Tailwind, Packagist, npm, Google Fonts…) más lo que la IA recomiende. Cada dirección pasa el filtro de seguridad y se comprueba que exista; no conecta servidores MCP ni nada que pida clave.
3. **Compara tu código** con lo que leyó y propone refactorizaciones. Tú las apruebas **una por una** («Aprobar y aplicar», «Ver diff» o «Rechazar»); si el archivo cambió, no se aplica.

Si lo detienes antes de que termine, las conexiones que no acabaron de leerse se borran por completo (datos y claves), también si el editor se cierra a la mitad: nunca queda nada incompleto. Mientras está encendido usa lo mejor disponible: en local, el modelo de chat más grande que cabe en tu memoria, contexto ampliado, todas las capas posibles en la GPU, todos los hilos menos uno y el modelo siempre cargado; en API, el mejor modelo del proveedor con razonamiento alto (en Anthropic, `claude-opus-5-5`, con respaldo a tu modelo si no existe). En modo API pide confirmación antes de enviar el resumen del proyecto.

## Compartir con GhostCode y MagicTools

Si están instaladas, **GhostCode** y **MagicTools** consultan lo que ya guardaste (ajuste `conexiones.share.enabled`, activo por defecto; se ve en Ajustes quién lo usa). Solo leen fragmentos guardados: sin red, sin claves, sin IA de por medio, y solo se añaden al prompt si de verdad vienen al caso. Con ello, el asistente de GhostCode (explicar/revisar código y arreglar problemas) y las herramientas con IA de MagicTools (y «Explicar el error») responden con la documentación de tus conexiones y la citan al final.

API para otras extensiones (`vscode.extensions.getExtension("edgar.conexiones").exports`, `version: 1`): `enabled()`, `connections()`, `search(query, opts)` y `context(query, opts)`, que devuelve un bloque `<docs>` con fuentes numeradas y un aviso de seguridad para el mensaje de sistema (`note`): lo guardado de la web se trata siempre como datos, nunca como órdenes.

## Tipos de conexión

| Tipo | Ejemplos | Qué hace |
|---|---|---|
| Documentación | W3Schools, Materialize, cualquier sitio de ayuda, `github.com/usuario/repo` (README) | Lee las páginas de ese sitio o carpeta (usa `llms.txt` o el mapa del sitio si existen), con pausas y respetando `robots.txt`. Solo vuelve a descargar lo que cambió (ETag). |
| Registro de paquetes | Packagist, npm | No descarga el registro: busca por tema cuando preguntas y guarda los paquetes que usas (descripción, versión, comando de instalación y README). |
| Iconos | Font Awesome | Descarga una vez la lista de iconos gratuitos (≈ 1 900, 1,6 MB). |
| Fuentes | Google Fonts | Descarga una vez la lista (≈ 1 900 fuentes, sin clave). Buscas por nombre, ves 10 por página con paginador, eliges pesos y cursiva y copias o insertas (con Preview) el código de cabecera. |
| Imágenes | Unsplash · Pexels · Openverse | Unsplash y Pexels usan su API oficial y piden una clave gratuita (Unsplash: unsplash.com/developers → *New Application* → *Access Key*; Pexels: pexels.com/api). **Openverse no pide clave** (imágenes con licencia abierta, con autor y licencia). Las miniaturas las descarga la extensión, el panel no toca la red. «Guardar en el proyecto» valida la imagen por sus bytes y la escribe en `assets/images` (ajustable). |
| Servidor MCP | Context7 y cualquier otro | Comprueba si responde y si falta la clave. Los servidores configurados en tu editor (`mcp.json`) se revisan sin ejecutarlos. |

## Seguridad

El objetivo es que conectar un enlace nunca pueda dañar tu equipo ni tus archivos:

- **Filtro de direcciones** (siempre activo): solo `https://`; sin usuario ni contraseña en el enlace; sin direcciones IP, `localhost` ni redes privadas; sin acortadores (`bit.ly`…); solo puertos web estándar; aviso en nombres con caracteres internacionales (homógrafos). Puedes añadir tus propios dominios bloqueados.
- **Comprobación al conectar**: el nombre se resuelve y se rechaza si apunta a una IP interna (protección contra *DNS rebinding*), también en cada redirección (máx. 5). Las claves de API no viajan a otro sitio en una redirección.
- **Solo lectura de texto**: se aceptan HTML, texto y JSON; nunca se descargan programas ni archivos. Límite de tamaño por página, de tiempo y de descarga total (también tras descomprimir). El HTML se reduce a texto: scripts, estilos, menús, anuncios y formularios se descartan.
- **Educado con los sitios**: respeta `robots.txt` y `Crawl-delay`, va despacio, se identifica y no intenta saltarse bloqueos (si un sitio rechaza a los lectores automáticos, te lo dice).
- **Nada se ejecuta**: ni el contenido leído, ni los comandos de los servidores MCP. El código que propone la IA solo se copia o se inserta con tu confirmación, y si parece peligroso (`curl … | sh`, `rm -rf`, `sudo`, claves, texto invisible…) se avisa antes.
- **Contenido no fiable**: lo leído se trata como datos. Los fragmentos que intentan dar órdenes a la IA («ignora las instrucciones anteriores…») se omiten y se avisa. La IA solo puede citar lo que está en la biblioteca.
- **Panel**: todo texto se inserta como texto (nunca como HTML) y el panel no puede cargar nada de internet. Los ajustes de seguridad se leen solo de tu configuración de usuario: un proyecto no puede cambiarlos. En carpetas no confiables no se leen archivos del proyecto.
- **Claves** en el llavero del sistema, no en archivos.

## Almacenamiento y borrado

Todo vive en la carpeta privada de la extensión (*Ajustes → Abrir carpeta*), una subcarpeta por conexión. **Al quitar una conexión se borra todo lo guardado de ella** (páginas, iconos, vectores) y su clave; se pide confirmación indicando cuánto se borra. *Vaciar datos* borra lo guardado pero mantiene la conexión; *Borrar todo* elimina todas. Al iniciar se limpian carpetas huérfanas. Hay un límite de espacio configurable (200 MB por defecto).

## Búsqueda

Búsqueda por palabras (BM25 con más peso a títulos, sin tildes, plurales y `camelCase`), con prioridad a las conexiones que coinciden con tu proyecto (detectado por `composer.json`, `package.json`, etc.). Con IA, la pregunta se traduce a términos técnicos en inglés para encontrar documentación en otro idioma. Opcional: **búsqueda por significado** con un modelo de embeddings de Ollama (`ollama pull nomic-embed-text`), que se une a la anterior.

## Instalación (VS Code y VSCodium)

```bash
npm ci
npm run package:install     # empaqueta e instala en todos los editores que encuentre (code, codium…)
npm run install:editors     # si ya existe dist-vsix/conexiones-<versión>.vsix
npm run release             # deja el .vsix en releases/ y quita los de versiones anteriores
```

Después recarga el editor (*Developer: Reload Window*).

## Configuración

`conexiones.mode` (local | api), `conexiones.local.url`, `conexiones.local.chatModel`, `conexiones.api.*`, `conexiones.language`, `conexiones.security.*`, `conexiones.sync.*`, `conexiones.storage.maxMb`, `conexiones.search.*`. La API key se guarda cifrada («Conexiones: Guardar API key»). Los ajustes de seguridad, red y almacenamiento solo se aplican desde la configuración de usuario.

## Desarrollo

`npm install` · `npm run typecheck` · `npm test` · `npm run package` · F5 para probarla.

Estructura: `src/core` (módulos puros: política de URLs, HTML→texto, trozos, búsqueda, seguridad), `src/net` (descarga segura y robots.txt), `src/store` (biblioteca local), `src/connectors` (documentación, Packagist/npm, Font Awesome, Google Fonts, Unsplash/Pexels/Openverse, MCP), `src/assistant.ts`, `src/panel.ts` y `media/` (vista). Añadir un registro nuevo = una entrada en `src/connectors/registry.ts`.

Las pruebas incluyen un test de extremo a extremo con servidores falsos y otro de la interfaz con jsdom. Atribuciones: iconos de Font Awesome Free (CC BY 4.0); fotos de Unsplash (da el crédito al autor).
