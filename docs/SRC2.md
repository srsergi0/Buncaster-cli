# Auditoría arquitectónica y de rendimiento del servidor

## 1. Alcance y método: distinguir el diseño declarado del comportamiento real

El código permite analizar el recorrido completo del audio: ingesta SRT, decodificación a PCM, reproducción de respaldo con dos decks, mezcla, codificación, distribución HTTP, prebuffer, administración y observabilidad.

Este análisis es estático: **no se ha ejecutado el servidor ni medido su rendimiento**. Por tanto, separaré:

- **Defectos verificables en el código**.
- **Riesgos que dependen del comportamiento de Bun, FFmpeg, el sistema operativo o los clientes**.
- **Propuestas cuyo beneficio debe comprobarse mediante pruebas controladas**.

Hay dos precisiones iniciales importantes.

### 1.1. El proyecto proporcionado no es estrictamente “sin dependencias externas”

Aunque el servidor HTTP utiliza Bun directamente, el proyecto incorpora:

- mcp-lite.
- React y React DOM.
- Los ejecutables FFmpeg y ffprobe.
- Bibliotecas compartidas mediante FFI: LAME, libavformat, libavcodec, libavutil y libswresample.

Esto obliga a distinguir dos objetivos diferentes:

1. **Arquitectura de control y distribución implementada exclusivamente con Bun y JavaScript**, manteniendo el subsistema multimedia externo que ya existe.
2. **Sistema completo sin ninguna dependencia externa**, incluidos codecs y transporte SRT.

El segundo objetivo no se obtiene sustituyendo algunas llamadas por APIs de Bun: Bun no proporciona de forma nativa un receptor SRT ni codificadores generales MP3 y Opus para el servidor. Mantener todas las funcionalidades actuales bajo esa restricción requeriría implementar componentes multimedia y de protocolo propios, o cambiar el contrato de entrada para recibir audio ya codificado.

Las propuestas principales de esta auditoría se concentran en mecanismos implementables con Bun y JavaScript moderno. Cuando una capacidad depende del subsistema multimedia existente, lo señalaré explícitamente.

### 1.2. No existen “fibers internos de Bun” utilizables como solución pública general

No sería riguroso recomendar supuestas APIs internas de fibers, acceso directo al planificador del runtime o zero-copy integral sobre HTTP sin contratos documentados.

Las herramientas reales para esta arquitectura son:

- Bun.serve y sus capacidades documentadas.
- Web Streams y sus mecanismos de contrapresión.
- Workers.
- SharedArrayBuffer y Atomics, verificando su comportamiento en la versión desplegada.
- Buffers transferibles.
- APIs de archivos, procesos y temporización.
- Sockets de Bun cuando el protocolo y su mantenimiento realmente lo justifiquen.

El salto arquitectónico debe proceder de **reducir trabajo, aislar interferencias y controlar la temporalidad**, no de atribuir capacidades inexistentes al runtime.

---

# 2. Reconstrucción del flujo: dónde se acoplan innecesariamente audio y tráfico

Actualmente hay varios productores capaces de llegar a writeToMaster:

- El lector del deck activo.
- El lector SRT o RTMP.
- El generador de silencio.

writeToMaster, a su vez:

1. Actualiza los contadores de muestras.
2. Escribe al proceso Opus.
3. Codifica MP3 mediante FFI o escribe al proceso master.
4. En modo LAME nativo, distribuye inmediatamente el resultado a todos los oyentes.

Este último detalle es decisivo: **con LAME nativo, el coste de distribuir audio a todos los clientes forma parte de la misma ejecución que consume y procesa audio**.

No existe una frontera clara entre:

- Tiempo de producción multimedia.
- Tiempo de codificación.
- Tiempo de distribución.
- Tiempo de administración.

Además, los chunks recibidos por un pipe determinan indirectamente:

- La granularidad de mezcla.
- La actualización de ganancias.
- El número de escrituras.
- La frecuencia de distribución.
- La rapidez de expulsión de clientes lentos.

Un chunk de I/O no es una unidad temporal multimedia estable. Es una consecuencia del buffering de varios componentes.

**El problema estructural es que el servidor está dirigido por las entregas de I/O, no por una línea temporal de audio explícita.**

---

# 3. Hallazgos críticos verificables

Antes de introducir optimizaciones avanzadas, conviene identificar fallos que invalidarían cualquier benchmark favorable.

| Área | Hallazgo en el código | Consecuencia |
|---|---|---|
| Audio en vivo | SRT y RTMP no utilizan el acumulador de residuos PCM | Posible fragmentación incorrecta de muestras y errores al construir vistas Int16Array |
| Crossfade hacia live | Se consume historyBuffer desde su parte más antigua | Puede reaparecer audio ya emitido |
| Relevo entre decks | Tras promover el siguiente deck se empiezan a enviar sus nuevos chunks, no necesariamente su FIFO pendiente | Posible salto de audio precargado |
| Precarga | El siguiente proceso se inicia al comenzar el crossfade | El fundido puede arrancar antes de disponer del siguiente audio |
| Reloj | Los fundidos y finales de pista dependen de Date.now | Sensibilidad al jitter, al retraso de metadatos y a cambios del reloj civil |
| Contrapresión de encoders | Se ignoran resultados y posibles promesas de write y flush | No se controla explícitamente el trabajo pendiente ni los errores asíncronos |
| Memoria publicada | broadcaster copia y AudioRingBuffer vuelve a copiar | Dos copias para una misma publicación |
| LAME | Se reservan 128 slots pese a que broadcaster ya copia la salida | Aproximadamente 9 MiB de almacenamiento de salida redundante |
| Ring buffer | Usa push, shift, filter y unshift sobre arrays | No es un anillo de acceso indexado y coste estable |
| Capacidad de buffers | Un único chunk puede superar el máximo configurado | Los límites no son estrictos |
| Opus | Se interpreta el primer chunk como cabeceras completas | Arranque no fiable ante fragmentación de páginas Ogg |
| Reinicios Opus | Las cabeceras y el prebuffer no se invalidan coordinadamente | Posible mezcla entre generaciones incompatibles |
| ICY | El prebuffer se envía sin pasar por chunkWithIcy | Desalineación del intervalo anunciado al cliente |
| HTTP | La caché de app.js se declara dentro del handler | Cada petición tiene su propia caché; puede recompilar por petición |
| HTTP | Ambos puertos utilizan el mismo handler completo | El puerto de salida también expone administración y construcción de frontend |
| Administración | Sin contraseña se permite acceso y el host predeterminado es público | Control administrativo expuesto por defecto |
| SRT | La clave mostrada en el streamid no se valida en el receptor visible | La clave no constituye autenticación efectiva en este código |
| Salud | Se devuelve estado “ok” sin comprobar progreso del audio codificado | Un encoder muerto puede aparentar salud |
| Métricas | El detector solo registra el bitrate en logs | Los campos detectedBitrateKbps y detectedSampleRate permanecen sin actualizar |
| Decoder nativo | Se importa, pero startFallback siempre ejecuta FFmpeg | La optimización declarada no está conectada a la ruta de reproducción |
| Playlist vacía | isPlaylistInitialized permanece falso y los rescans retornan anticipadamente | La incorporación de archivos puede no activar la reproducción |
| Logs | Cola ilimitada y escritura duplicada en dos archivos | Riesgo de crecimiento de memoria y amplificación de I/O |
| Apagado | Se llama a process.exit sin esperar drenaje y cierre | Truncamiento y pérdida de trabajo pendiente |

Estos problemas no tienen el mismo peso. La doble copia consume recursos; una cronología de audio incorrecta compromete directamente el servicio.

---

# 4. Primer cambio estructural: un único propietario de la línea temporal multimedia

## 4.1. Fundamento técnico

El servidor necesita diferenciar tres magnitudes:

1. **Muestras recibidas de una fuente**.
2. **Muestras comprometidas en la salida del mezclador**.
3. **Muestras representadas en audio codificado publicado**.

Hoy audioClockSamples y audioSamplesProduced aumentan antes de saber si el encoder está operativo y si la escritura se ha completado. Por tanto, no constituyen evidencia de salida útil.

La propuesta es establecer un **motor multimedia con un único propietario de la salida PCM**.

Los lectores de archivos y red alimentarían buffers. No escribirían directamente al master. El motor decidiría qué muestras ocupan cada intervalo de la línea temporal.

## 4.2. Implementación conceptual con Bun y JavaScript

El motor mantendría:

- Un contador monotónico de frames de salida.
- Buffers separados por fuente.
- Posiciones de lectura expresadas en muestras.
- Un estado de transición explícito.
- Un presupuesto de anticipación.
- Una política explícita de discontinuidad.

Las unidades de procesamiento podrían situarse inicialmente entre 10 y 20 ms, ajustándose después mediante mediciones. No es necesario que cada unidad provoque inmediatamente una escritura de red.

Las transiciones se expresarían en número de muestras, no en diferencias entre fechas civiles.

performance.now serviría para relacionar la producción con tiempo monotónico. El reloj de muestras representaría la continuidad del contenido.

**Los temporizadores de Bun no ofrecen tiempo real duro.** El objetivo no es convertir JavaScript en un sistema operativo de tiempo real, sino dejar de permitir que cualquier variación de I/O redefina la cronología del audio.

## 4.3. Evitar un nuevo error: el reloj maestro también necesita disciplina

Una fuente de audio real puede derivar ligeramente respecto al reloj del servidor. Una diferencia de 100 partes por millón acumula aproximadamente 0,36 segundos por hora.

Por ello, no basta con consumir eternamente exactamente 48.000 frames por segundo de reloj local.

Hay que observar:

- Tendencia de ocupación del buffer de entrada.
- Tasa efectiva de llegada de muestras.
- Variaciones transitorias frente a deriva sostenida.

Cuando la infraestructura multimedia existente permita compensación de remuestreo, puede aplicarse allí. Bajo Bun/JS estricto, una corrección de calidad requiere implementar un remuestreador adecuado; no debe presentarse como una primitiva incorporada.

Una primera implementación puede mantener márgenes acotados y políticas explícitas de discontinuidad, evitando correcciones abruptas frecuentes.

## 4.4. Impacto y escenario

**Escenario:** el proceso de ingesta entrega 120 ms de PCM en una ráfaga tras una pausa.

Actualmente esa ráfaga puede convertirse inmediatamente en mezcla, codificación y fan-out.

Con el nuevo modelo:

- La ráfaga alimenta el buffer.
- La salida mantiene una cronología controlada.
- El fundido conserva su duración en muestras.
- La distribución no recibe necesariamente la misma ráfaga.

El diferencial no es únicamente menor latencia media: es **menor variación temporal y comportamiento estable ante perturbaciones**.

---

# 5. Crossfades correctos: reemplazar historia retrospectiva por audio futuro disponible

## 5.1. Por qué historyBuffer es conceptualmente incorrecto para esta transición

El deck activo introduce audio en historyBuffer después de recibirlo y también lo emite.

Cuando entra live, el código extrae audio desde el principio de ese historial.

Eso no representa “la música que debería seguir sonando”. Representa música anterior, potencialmente ya escuchada segundos antes.

Un crossfade necesita solapamiento entre:

- La continuación futura de la fuente saliente.
- El comienzo de la fuente entrante.

No debe reconstruirse con audio retrospectivo salvo que se trate deliberadamente de un efecto de repetición.

## 5.2. Rediseño viable

Todos los decks deben atravesar siempre su FIFO, incluso cuando son activos.

Así se mantiene una sola posición de consumo por deck:

- Decodificar produce muestras.
- El motor consume muestras.
- Cambiar de PRELOADING a PLAYING no cambia el camino de los datos.
- La promoción de un deck no salta su contenido pendiente.

El estado READY, ya declarado pero no utilizado de forma efectiva, debería significar una condición verificable: suficiente audio válido y alineado para realizar el relevo.

La siguiente pista se prepara **antes** del inicio del crossfade, con un horizonte basado en el tiempo de apertura y primer audio observado.

## 5.3. Ganancias continuas

Actualmente cada chunk recibe una ganancia constante. Si cambia el tamaño del chunk, cambia la granularidad del fundido.

La envolvente debería evolucionar por muestra o por subbloques pequeños, independientemente de la segmentación del pipe.

El fundido equal-power es razonable para fuentes no correlacionadas, pero no garantiza ausencia de picos cuando las señales están correlacionadas. Debe acompañarse de headroom o limitación coherente.

## 5.4. Impacto y límites

**Escenario:** la siguiente pista está en un disco lento y tarda 300 ms en producir audio.

Hoy puede mezclarse silencio al principio de la transición.

Con precarga por disponibilidad:

- Se inicia la apertura con margen.
- Se conoce si el siguiente deck está preparado.
- Si no lo está, se aplica una política explícita: retrasar el relevo, prolongar el saliente cuando sea posible o efectuar una transición de emergencia.

No se puede prometer continuidad perfecta cuando ninguna fuente dispone de muestras futuras. Sí se puede evitar que el servidor provoque discontinuidades teniendo audio utilizable en memoria.

---

# 6. Separación de planos: que diez mil oyentes no alteren el mezclador

## 6.1. Fundamento técnico

El trabajo PCM depende del número de fuentes y rendiciones. El fan-out depende del número de oyentes.

Mezclar ambos en el mismo event loop introduce una dependencia perjudicial:

**Más oyentes implican mayor retraso potencial en la ingesta y el procesamiento.**

El rediseño debe separar:

### Plano multimedia

- Consumo de fuentes.
- Mezcla.
- Control temporal.
- Publicación de rendiciones.

### Plano de distribución

- Conexiones HTTP.
- Contrapresión.
- Arranque de clientes.
- ICY.
- Expulsiones.

### Plano de control

- Playlist.
- Metadatos.
- Administración.
- Archivos.
- Observabilidad.
- Frontend.

## 6.2. Implementación en Bun

Workers o procesos Bun permiten aislar estos dominios.

Una partición inicial sensata sería:

- Un propietario del motor de audio.
- Un distribuidor HTTP.
- Un trabajador de tareas de catálogo y control pesado.

Después, si las mediciones lo justifican, se fragmenta la distribución en varios trabajadores.

No conviene crear un worker por oyente. El overhead de aislamiento y mensajería superaría cualquier ventaja.

Para comunicar audio codificado:

- Buffers transferibles cuando haya un único destinatario.
- Una copia por distribuidor cuando la simplicidad sea más importante.
- SharedArrayBuffer y descriptores de bloques cuando la escala justifique su complejidad.

Un ArrayBuffer transferido deja de pertenecer al emisor: no puede transferirse simultáneamente a múltiples distribuidores como si fuera memoria compartida.

## 6.3. Riesgos

Los workers aíslan ejecución JavaScript, pero comparten recursos físicos y, normalmente, proceso.

Un fallo nativo grave dentro de FFI puede derribar el proceso completo. Un worker no es una barrera suficiente frente a corrupción de memoria nativa.

Para aislar codecs potencialmente inseguros, los procesos son una frontera más fuerte. Eso utiliza capacidades de Bun, aunque el codec externo sigue siendo una dependencia.

## 6.4. Impacto

**Escenario:** miles de oyentes se conectan durante una transición entre pistas.

Con el diseño actual, altas, logs, prebuffer y distribución compiten con el audio.

Con planos separados, la saturación HTTP puede causar rechazo de nuevas conexiones, pero no debería alterar el reloj del mezclador.

Esta es una mejora de **aislamiento de fallos y escalabilidad**, no una promesa de reducir a cero el coste total de CPU.

---

# 7. Distribución por cursores: conservar una publicación común sin acumular audio por cliente

## 7.1. Qué hace bien el código actual

broadcaster comparte el mismo Uint8Array entre los clientes de una publicación. No existe una copia JavaScript del payload por oyente en esa función.

Por tanto, sería incorrecto afirmar que toda la memoria actual crece como “audio completo copiado por cada usuario”.

Sin embargo, cada ReadableStream mantiene su propia cola de referencias y el runtime o el sistema operativo pueden almacenar datos adicionales.

## 7.2. Debilidad actual

Cada publicación recorre todos los clientes y encola datos, estén o no preparados.

Esto genera:

- Operaciones por cliente y chunk.
- Referencias retenidas.
- Colas individuales.
- Comprobación de contrapresión después de añadir más datos.

El anillo existente ya contiene secuencias, pero readSince no se utiliza como base del consumo de clientes.

## 7.3. Rediseño propuesto

Una rendición mantendría un historial compartido y acotado.

Cada cliente conservaría principalmente:

- Cursor de secuencia.
- Desplazamiento dentro del bloque.
- Generación.
- Estado ICY.
- Presupuesto de retraso.

El pull del ReadableStream obtendría contenido únicamente cuando exista demanda.

Si un cliente alcanza el borde en vivo, queda esperando una notificación. Si está retrasado, no necesita recibir otra notificación por cada publicación: ya dispone de trabajo pendiente.

Esto requiere un registro de lectores esperando datos y un mecanismo de despertar por lotes.

**No es necesario crear una promesa nueva por cliente y por paquete.** Ese patrón podría reemplazar el overhead actual por otro.

## 7.4. Límite físico y complejidad real

El coste de enviar un flujo unicast sigue siendo proporcional al número de receptores. Un ring compartido no transforma N conexiones TCP en multicast.

La ganancia está en reducir:

- Estado retenido.
- Encolados innecesarios.
- Trabajo para clientes bloqueados.
- Variabilidad del uso de memoria.

También debe quedar claro que eliminar datos del ring no libera un bloque todavía retenido por un stream o transporte.

## 7.5. Escenario e impacto

**Escenario:** el 5 % de los clientes deja de leer durante varios segundos.

Con cursores:

- La publicación continúa.
- Los clientes lentos no obligan a ampliar el historial.
- Se detecta cuándo un cursor sale de la ventana admisible.
- Se cierra o resincroniza según las capacidades del formato y del reproductor.

No debe saltarse arbitrariamente dentro de MP3 u Ogg: la política de resincronización es parte del protocolo multimedia.

---

# 8. Contrapresión en tiempo y por etapa, no “cinco chunks de castigo”

## 8.1. El problema de MAX_SLOW_STRIKES

Cinco publicaciones pueden equivaler a:

- 100 ms.
- Un segundo.
- Varios segundos.

Depende del encoder, el muxer y los pipes.

Además, el highWaterMark bajo en latencia es de 64 KiB para ambos tiers:

- A 320 kbps representa aproximadamente 1,64 segundos de payload.
- A 96 kbps representa aproximadamente 5,46 segundos.

Por tanto, el mismo límite en bytes permite más del triple de retraso en Opus.

Esto es especialmente contradictorio en un modo denominado lowLatency.

## 8.2. Política propuesta

Cada etapa debe tener límites diferenciados:

| Etapa | Control principal |
|---|---|
| Ingesta PCM | Ocupación y antigüedad de muestras |
| Mezclador → encoder | Muestras pendientes de aceptación |
| Encoder → publicación | Tiempo desde último progreso |
| Publicación → cliente | Retraso del cursor y bytes pendientes |
| Transporte | Presión observable y timeout |
| Alta de cliente | Presupuesto de arranque |

Para audio de bitrate variable, el retraso debe derivarse de duración multimedia, no exclusivamente de bytes.

Un cliente se considera problemático por una combinación de:

- Retraso sostenido.
- Falta de progreso.
- Tendencia creciente.
- Presupuesto excedido.

## 8.3. Contrapresión de procesos

Las escrituras a stdin y sus flush no deben tratarse como “sincrónicas y definitivamente consumidas” solo por estar dentro de un try/catch.

Se deben respetar los contratos de la versión concreta de Bun:

- Resultado de la escritura.
- Finalización del flush cuando sea asíncrono.
- Rechazos.
- Cierre del destino.

El sistema debe decidir qué sucede cuando un encoder no acepta PCM.

Por ejemplo, Opus no debería acumular indefinidamente ni bloquear sin límite la salida MP3. Pero tampoco es correcto descartar PCM arbitrariamente y fingir que la cronología Opus sigue intacta: puede ser necesario declarar discontinuidad y reiniciar esa rendición.

## 8.4. Cierre de clientes

controller.close solicita un cierre ordenado del stream. **No debe suponerse que elimina inmediatamente todo lo ya encolado o que fuerza el cierre instantáneo del socket.**

La expulsión necesita una estrategia probada en Bun para:

- Interrumpir producción.
- Liberar registros.
- Cancelar esperas.
- Terminar el cuerpo.
- Limitar retención posterior.

## 8.5. Impacto

La transformación es pasar de una heurística dependiente de chunks a un **contrato temporal medible**.

Un cliente móvil que se detiene brevemente puede recuperarse sin expulsión injustificada. Uno que acumula retraso de manera sostenida deja de consumir recursos ilimitados.

---

# 9. Propiedad de memoria: una copia deliberada es mejor que un “zero-copy” inseguro

## 9.1. Copias redundantes actuales

La secuencia visible es:

1. El encoder genera datos.
2. broadcaster crea una copia.
3. preBuffer los entrega a AudioRingBuffer.
4. AudioRingBuffer crea otra copia.

La segunda copia puede eliminarse si se establece un contrato: el ring recibe bloques ya publicados e inmutables por disciplina de propiedad.

No existe inmutabilidad real de los bytes de un Uint8Array por el mero nombre de una variable. La garantía debe proceder de que ningún componente conserve permiso para modificarlos.

## 9.2. El anillo de salida LAME ya no cumple una función proporcional a su tamaño

LameEncoder reserva 128 bloques de 72 KiB, unos 9 MiB.

El comentario justifica ese tamaño mediante el tiempo que los clientes podrían retener la salida. Sin embargo, broadcaster la copia inmediatamente.

Si el contrato permanece así, basta un almacenamiento de trabajo mucho menor, reutilizable después de copiar.

Además, el comentario supone aproximadamente una llamada de codificación por segundo. La ruta real no fija esa cadencia: startFallback no configura el supuesto agrupamiento de una segunda mencionado en otros comentarios.

Una garantía basada en “128 llamadas equivalen a 128 segundos” no es válida.

## 9.3. Pool PCM

El pool PCM rota cuatro buffers y supone que write más flush dejan el contenido disponible para reutilización.

Esto exige validación, especialmente porque el mismo bloque se envía a dos destinos.

La mejora segura consiste en definir estados de propiedad:

- En escritura.
- Publicado.
- Pendiente de consumo por destino.
- Reciclable.

Si esa confirmación no es observable de manera fiable en una API, una copia en esa frontera puede ser la decisión correcta.

## 9.4. Un ring verdadero

AudioRingBuffer y AudioStreamBuffer deberían usar índices de cabeza y cola sobre almacenamiento acotado.

Esto evita depender del coste de eliminar el primer elemento de un array y permite:

- Encontrar una secuencia directamente.
- Recorrer dos tramos contiguos cuando el anillo envuelve.
- No filtrar todo el historial por cliente.
- No usar unshift para construir snapshots.

También hay que definir el comportamiento ante bloques mayores que la capacidad:

- Dividir en unidades válidas.
- Rechazar el bloque.
- Aplicar una excepción acotada y observable.

“Conservar siempre el último chunk aunque exceda el máximo” no es un límite estricto.

## 9.5. Impacto y prioridad

Eliminar 9 MiB y una copia por publicación es útil, pero no constituye por sí solo una revolución para una emisora.

El beneficio crece con:

- Muchas emisoras por proceso.
- Muchas rendiciones.
- Chunks pequeños y alta tasa de objetos.
- Cargas cercanas al umbral de GC.

Debe priorizarse por debajo de corregir el reloj y el arranque multimedia.

---

# 10. Publicación consciente del formato: el chunk del pipe no es una unidad reproducible

## 10.1. Ogg/Opus: defecto de arranque

pipeOpus busca texto OpusHead en los primeros bytes de un chunk y almacena ese chunk completo como cabeceras.

Pero el pipe puede entregar:

- Media página Ogg.
- Una página completa.
- Varias páginas.
- Cabeceras y audio mezclados.
- OpusHead separado de OpusTags.

Por tanto, no se puede usar el primer chunk como unidad semántica.

Al incorporar un oyente, además, se envían esas supuestas cabeceras seguidas de un snapshot o del audio actual. No hay garantía de compatibilidad entre esas piezas.

## 10.2. Propuesta

Implementar en JavaScript un parser incremental del contenedor que reconstruya:

- Cabeceras Ogg.
- Tablas de segmentos.
- Paquetes continuados.
- Páginas completas.
- Número de serie.
- Secuencias.
- Granule positions.
- OpusHead y OpusTags.

Es una tarea viable sin dependencias, pero requiere pruebas de formato y reproducción reales.

El parser permitiría construir **puntos de incorporación válidos**, no simples snapshots de bytes.

La política de entrada en mitad de un flujo Ogg/Opus debe considerar preroll, continuidad y compatibilidad de reproductores. Ante la necesidad de remultiplexar, también habrá que recalcular los campos y CRC correspondientes.

No basta con anteponer las cabeceras originales y asumir que todos los clientes aceptarán cualquier salto posterior.

## 10.3. Generaciones de encoder

Cada reinicio debe producir una nueva generación.

Cabeceras, páginas, historial y cursores deben pertenecer a esa generación.

Actualmente:

- El prebuffer no se reinicia coordinadamente.
- opusHeaders puede sobrevivir a una muerte inesperada del proceso.
- stopOpusEncoder retorna anticipadamente si no hay proceso, sin necesariamente limpiar el estado previo.

La generación debe ser una condición del contrato de publicación, no un campo opcional que siempre queda en cero.

## 10.4. MP3 y otros formatos

MP3 necesita alineación de frames y consideración del bit reservoir. Una cabecera válida no garantiza que ese frame sea totalmente independiente de bytes anteriores.

AAC/ADTS necesita límites de frame.

Ogg/Vorbis y FLAC tienen sus propias necesidades de inicialización.

La abstracción correcta es:

**rendición + parser + configuración de arranque + ventana multimedia válida**.

No una ruta llamada /mp3 que pueda contener cualquier formato sin adaptar el mecanismo de incorporación.

## 10.5. Impacto

**Escenario:** un oyente Opus entra diez minutos después de iniciar el encoder.

El diseño actual depende de tolerancias del reproductor y de cómo FFmpeg fragmentó sus primeras escrituras.

Con publicación consciente del formato se puede medir y garantizar un contrato de arranque concreto.

La reducción de reconexiones fallidas puede ahorrar más CPU y ancho de banda que muchas microoptimizaciones de JavaScript.

---

# 11. ICY: corregir la cronología de bytes y aprovechar un prefijo compartido

## 11.1. Error actual

El servidor anuncia un intervalo ICY de 65.536 bytes de audio.

Sin embargo, el prebuffer se envía directamente y el contador ICY empieza en cero para las publicaciones posteriores.

Para el cliente, el conteo comenzó al primer byte del cuerpo HTTP. Por tanto, la posición esperada del primer bloque de metadatos no coincide con la enviada.

Si el prebuffer supera un intervalo, incluso puede interpretarse audio como longitud de metadatos.

## 11.2. Corrección viable

El prebuffer debe atravesar exactamente el mismo estado ICY que el resto de la respuesta.

Los metadatos también deben asociarse con la posición del contenido. Si se envía audio anterior al borde en vivo, el título actual puede no corresponder al audio escuchado.

La caché metaBlockCache necesita límite de tamaño o política de expiración: hoy crece con cada título distinto.

## 11.3. Optimización avanzada: dos publicaciones lógicas

Puede mantenerse:

- Una rendición de audio puro.
- Una publicación ICY con intervalos globales.

Los clientes ICY se incorporan desde un punto que preserve correctamente el conteo anunciado.

Con ello, la segmentación y construcción de bloques ICY puede compartirse entre clientes sincronizados.

No siempre será compatible con un arranque arbitrariamente cercano al borde en vivo. La elección del punto de incorporación debe equilibrar:

- Latencia.
- Corrección de formato.
- Trabajo compartido.

## 11.4. Impacto

En cientos de clientes, el ahorro será moderado. En miles de oyentes ICY, reducir arrays temporales, vistas y segmentaciones repetidas puede convertirse en una mejora relevante del fan-out.

La corrección del prebuffer, en cambio, debe realizarse independientemente de la escala.

---

# 12. Eficiencia global: el bitrate pesa más que muchas optimizaciones del runtime

## 12.1. Presupuesto físico

Para 500 oyentes:

- MP3 a 320 kbps requiere unos 160 Mbps de payload.
- Opus a 96 kbps requiere unos 48 Mbps.

Para 10.000 oyentes:

- MP3 a 320 kbps: aproximadamente 3,2 Gbps.
- Opus a 96 kbps: aproximadamente 0,96 Gbps.

No incluyen cabeceras, TLS ni retransmisiones.

Pasar de 320 a 96 kbps reduce el payload un 70 %. **No significa que ambos tengan calidad equivalente para cualquier contenido y oyente**, pero muestra dónde reside una de las mayores palancas de capacidad.

## 12.2. Propuesta

Ofrecer una rendición eficiente como preferencia para clientes compatibles, conservando una alternativa de compatibilidad.

El cliente puede seleccionar mediante capacidades de reproducción y una prueba real de arranque.

No debe intentarse cambiar el codec silenciosamente dentro de la misma respuesta HTTP.

Para adaptación de bitrate:

- El protocolo debe admitir el cambio.
- El reproductor debe coordinarlo.
- Puede requerirse reconexión o un esquema de segmentos.

## 12.3. Codificación bajo demanda

Opus se codifica siempre, incluso sin oyentes.

En entornos con muchas emisoras, activar rendiciones bajo demanda puede ahorrar CPU de forma importante.

Pero hay costes:

- Latencia de primer arranque.
- Nuevas cabeceras.
- Recalentamiento del encoder.
- Reinicios por oscilación de audiencia.

La solución necesita una permanencia mínima y un período de gracia después del último cliente.

Para una sola emisora con dos codecs, mantener ambos calientes puede ser la decisión más robusta.

La implementación del control es viable en Bun; la codificación sigue dependiendo del subsistema multimedia externo existente.

## 12.4. DSP coherente

El modo LAME nativo se activa aunque audioProcessing sea verdadero, pero no ejecuta el mismo procesamiento que FFmpeg.

Así, comparar CPU entre ambos caminos mezcla dos cambios:

- Eliminar proceso y pipes.
- Eliminar procesamiento de audio.

Además, cuando ambas rendiciones pasan por FFmpeg, cada una ejecuta su propio loudnorm y compand.

Una arquitectura más coherente procesa el PCM común una vez antes de ramificar, siempre que se mantengan las garantías acústicas y temporales.

Bajo JS estricto pueden implementarse ganancias y DSP propio, pero una normalización y un limitador de alta calidad requieren diseño y validación; no son gratuitos ni equivalentes automáticamente a loudnorm.

---

# 13. FFI: eliminar proceso no equivale necesariamente a mejorar el servidor

## 13.1. LAME síncrono en el event loop

El wrapper LAME evita pipes y un proceso, pero la codificación se ejecuta sincrónicamente en el hilo que atiende otras tareas JavaScript.

Una mejora de CPU total puede coexistir con un empeoramiento de:

- Latencia p99 del servidor.
- Tiempo de respuesta a conexiones.
- Jitter de distribución.
- Retraso del watchdog.

Por eso debe medirse el tiempo de cada llamada, no solo el porcentaje global de CPU.

## 13.2. El decoder nativo no está integrado y no debe activarse sin revisión

Además de no utilizarse en startFallback, presenta riesgos importantes:

- Offsets de estructuras C fijados manualmente.
- Intento de cargar distintas versiones con esos mismos offsets.
- Derivación de versiones de bibliotecas que no es válida universalmente.
- Supuestos de arquitectura y endianess.
- Apertura y lectura potencialmente bloqueantes.
- Fragmentos de alrededor de un segundo.
- Tratamiento de EOF y drenaje incompleto.
- Falta de drenaje final explícito del remuestreador.
- Liberación de un paquete aunque send_packet devuelva EAGAIN, sin conservarlo para reintento.
- Ausencia de cancelación del productor vinculada directamente al cancel del stream.

También compara desiredSize con una cantidad de bytes, pero el ReadableStream se construye sin estrategia de tamaño en bytes. Por defecto, ese valor representa unidades de chunks, no bytes.

El umbral negativo utilizado puede permitir una acumulación enorme antes de activar el supuesto backoff.

## 13.3. Recomendación viable bajo la restricción solicitada

No recomendaría profundizar en lectura manual de estructuras privadas como estrategia de rendimiento.

Para el núcleo Bun/JS:

- Aislar ejecución pesada.
- Mantener contratos de entrada/salida claros.
- Desactivar rutas no verificadas.
- Eliminar cargas laterales de módulos no utilizados.
- Medir si el ahorro de pipes es relevante.

Si se mantienen dependencias multimedia externas, las interfaces de ABI estable y el aislamiento de procesos ofrecen un compromiso más seguro que offsets adivinados.

**Una caída por corrupción de memoria destruye cualquier ganancia de microsegundos.**

---

# 14. Control y archivos: eliminar interferencias que hoy pueden paralizar el audio

## 14.1. Recompilación del frontend por petición

appJsCache y appJsBuilding están dentro del handler HTTP.

Cada petición obtiene nuevas variables, por lo que:

- No existe caché persistente.
- No existe consolidación de builds concurrentes entre peticiones.
- /app.js puede convertirse en una vía de consumo intensivo de recursos.

La solución de mayor rendimiento es construir el frontend antes de arrancar y servir un archivo mediante Bun.file.

Si se exige ausencia de dependencias, la UI puede implementarse con DOM y módulos de navegador, sin React.

**Escenario:** cincuenta aperturas simultáneas del panel no deberían provocar cincuenta compilaciones.

## 14.2. Playlist incremental y fuera del plano de audio

Cada cinco segundos se recorre recursivamente el árbol mediante operaciones síncronas.

Con una biblioteca grande, el tiempo de bloqueo crece aunque no cambie ninguna canción.

Además, las búsquedas repetidas con includes convierten partes de la reconstrucción en trabajo cuadrático.

Propuesta:

- Escaneo inicial separado del motor multimedia.
- Inventario indexado mediante Map o Set.
- Eventos del watcher agrupados.
- Reconciliaciones periódicas limitadas.
- Límites de profundidad y control de enlaces simbólicos.
- Verificación de estabilidad antes de aceptar archivos que todavía se están copiando.
- Estado explícito de catálogo vacío, no “inicialización fallida”.

Esto es implementable con APIs de archivos y workers de Bun.

## 14.3. Metadatos y caché

Actualmente una actualización puede provocar:

- stat síncrono.
- ffprobe.
- Serialización del catálogo completo.
- Escritura síncrona.

Conviene:

- Consolidar consultas simultáneas al mismo archivo.
- Limitar concurrencia y tiempo de ffprobe.
- Acotar su salida.
- Persistir por lotes.
- Escribir temporalmente y reemplazar de manera atómica cuando el sistema de archivos lo permita.
- Separar la fecha de llegada del metadato de la posición real de reproducción.

Retrasar metadatos no debe reiniciar startedAt.

## 14.4. Logs

La cola de logs no tiene límite y escribe lo mismo en dos archivos.

Propuesta:

- Un único destino cuando no haya una necesidad explícita de duplicación.
- Cola acotada por bytes.
- Muestreo de eventos repetitivos.
- Agregación de altas y bajas bajo avalanchas.
- Rotación.
- Contadores de mensajes descartados.
- Política de degradación ante disco lento o lleno.

Los logs de oyentes pueden convertirse en una amplificación de I/O controlada por tráfico externo.

La observabilidad debe describir una sobrecarga, no agravarla.

---

# 15. Autocuración verificable: supervisar progreso, no solo existencia de procesos

## 15.1. Por qué el watchdog actual es insuficiente

El watchdog observa la última llegada de PCM de la fuente live.

No detecta adecuadamente:

- Encoder master vivo pero sin producir salida.
- Opus muerto mientras MP3 funciona.
- Mezclador produciendo métricas sin destino.
- Distribución bloqueada.
- Fallback sin audio.
- Fallo de cabeceras al reiniciar una rendición.

Además, marcar isBroadcasting como falso y llamar startFallback desde el watchdog interactúa con el finally del listener. Sin un propietario único de la transición, pueden producirse acciones redundantes o estados incoherentes.

## 15.2. Supervisor por etapas

Cada etapa debe publicar un contador de progreso y una marca monotónica:

- Entrada recibida.
- PCM válido ensamblado.
- PCM comprometido.
- PCM aceptado por encoder.
- Audio codificado.
- Publicación.
- Consumo por distribución.

Una etapa detenida se localiza comparando avances entre fronteras.

Por ejemplo:

- Avanza PCM, no avanza codificado: problema de encoder.
- Avanza codificado, no publicación: problema de distribución interna.
- Avanza publicación, muchos clientes se retrasan: saturación de salida o clientes.

## 15.3. Reparación mínima

El supervisor debe actuar sobre el menor dominio posible:

- Reiniciar solo una rendición.
- Invalidar su generación.
- Mantener las demás.
- Rechazar temporalmente altas.
- Reducir trabajo administrativo.
- Cambiar a fallback si la fuente deja de ser utilizable.

Debe incorporar:

- Backoff.
- Histéresis.
- Máximo de reinicios.
- Ventana de estabilización.
- Registro de causa.
- Bloqueo contra reinicios simultáneos.

Un “self-healing” sin estas restricciones puede crear una tormenta de reinicios.

## 15.4. Métricas honestas

Los contadores actuales denominados bytes enviados miden principalmente bytes encolados de audio.

No incluyen de forma coherente:

- Prebuffer.
- Cabeceras Opus.
- Metadatos ICY.
- Confirmación de recepción remota.

Conviene nombrarlos según lo realmente observado.

También deben separarse:

- Liveness del proceso.
- Readiness para aceptar oyentes.
- Salud del audio.
- Salud por rendición.

La salud del modo LAME no puede depender de que state.masterProcess sea distinto de null.

---

# 16. Seguridad de recursos: una condición necesaria para escalar

## 16.1. Administración expuesta

Con adminPassword vacío, checkAdminAuth acepta cualquier petición. El host predeterminado es 0.0.0.0.

Esto permite que un despliegue sin configuración adicional exponga operaciones como:

- Cambiar la fuente.
- Encolar rutas o URLs.
- Saltar pistas.
- Detener el proceso.

Además, ambos puertos sirven el mismo conjunto de rutas.

La propuesta es:

- Administración cerrada por defecto.
- Listener administrativo separado y local cuando corresponda.
- Credenciales distintas para ingestión y administración.
- Rutas de salida limitadas estrictamente a reproducción.
- HTTPS mediante capacidades TLS de Bun cuando la exposición lo requiera.

## 16.2. URLs y rutas como consumo arbitrario de recursos

Las APIs aceptan entradas que FFmpeg puede intentar abrir.

No hace falta inyección de shell para causar problemas:

- Acceso a destinos internos.
- Streams que nunca terminan.
- Archivos enormes.
- Demuxers costosos.
- Rutas fuera del catálogo.
- Protocolos no previstos.

La validación debe limitar:

- Raíces de archivos autorizadas.
- Protocolos.
- Destinos de red.
- Redirecciones cuando proceda.
- Duración de apertura.
- Tamaño de cola.
- Concurrencia.

No debe confundirse una comprobación textual de URL con protección completa frente a resolución DNS o cambios de destino.

## 16.3. IP confiable y admisión

getClientIp confía directamente en x-forwarded-for.

Solo debe aceptarse ese encabezado cuando el peer inmediato pertenezca a una lista de proxies confiables.

La admisión debería utilizar presupuestos separados para:

- Altas por intervalo.
- Conexiones activas.
- Arranques con prebuffer.
- Operaciones administrativas.
- Conexiones sin progreso.

Los límites por IP necesitan tolerancia a NAT compartido; no pueden ser el único mecanismo.

## 16.4. SRT: corregir expectativas

El código no verifica el streamid mostrado como clave.

También conviene revisar las unidades de latency, rcvlatency y peerlatency: **en las opciones SRT de FFmpeg se expresan en microsegundos**, por lo que el valor 20 no corresponde a 20 ms.

SRT tampoco elimina cualquier forma de espera por recuperación ni implica universalmente “0-RTT”. Usa retransmisión y buffering, y su rendimiento depende de RTT, pérdidas y ventana de latencia.

Este punto pertenece al subsistema externo existente; no se soluciona con una optimización de JavaScript.

---

# 17. Innovaciones adicionales de alto impacto, pero condicionadas a evidencia

## 17.1. Agrupación temporal adaptativa

### Fundamento

Enviar un bloque demasiado pequeño aumenta llamadas y operaciones por oyente. Agrupar demasiado añade latencia.

### Implementación conceptual

Separar la unidad de mezcla de la unidad de publicación.

El distribuidor agrupa frames o páginas completas hasta alcanzar:

- Un límite de bytes.
- Una fecha máxima de entrega.

El tamaño se ajusta a la carga observada, dentro de un presupuesto temporal fijo.

### Impacto

Con 10.000 oyentes, pasar de 50 a 20 publicaciones por segundo reduce las visitas lógicas de distribución de 500.000 a 200.000 por segundo, antes de considerar batching interno del runtime.

No garantiza una reducción proporcional de CPU, pero sí elimina trabajo potencial.

### Riesgo

Nunca agrupar por encima del presupuesto de latencia ni dividir estructuras multimedia de manera incompatible.

---

## 17.2. Incorporaciones agrupadas para amortizar el arranque

### Fundamento

Una avalancha de conexiones solicita casi el mismo prefijo de audio.

### Implementación conceptual

Agrupar altas en ventanas cortas y ofrecer un punto de incorporación válido compartido, manteniendo un límite de espera.

La construcción del prefijo, las referencias y ciertas transformaciones se reutilizan.

### Impacto

Reduce trabajo de preparación durante flash crowds y hace más predecible el coste de arranque.

### Riesgo

Añade una pequeña espera deliberada. Debe ser opcional y justificarse con pruebas.

---

## 17.3. Preparación predictiva basada en percentiles

### Fundamento

El tiempo de apertura de una pista depende de disco, formato, caché y carga.

### Implementación conceptual

Registrar el tiempo hasta primer PCM válido por clase de fuente y preparar la siguiente pista con un horizonte basado en percentiles altos.

No es necesario introducir aprendizaje automático.

### Impacto

Reduce huecos sin mantener toda la biblioteca decodificada.

### Riesgo

Una predicción no sustituye al estado READY. Los archivos anómalos requieren timeout y alternativa.

---

## 17.4. Caché selectiva de PCM para contenido repetido

### Fundamento

Jingles y pistas cortas pueden decodificarse muchas veces.

### Implementación conceptual

Mantener una caché acotada por bytes, coste de preparación y frecuencia de uso.

A 48 kHz, estéreo y 16 bits, un minuto ocupa aproximadamente 11,52 MB. Esto hace inviable cachear indiscriminadamente bibliotecas grandes.

### Impacto

En emisoras con contenido repetitivo puede reducir aperturas, picos de CPU y latencia de relevo.

### Riesgo

En contenido poco repetido consume RAM sin retorno. La decodificación inicial sigue dependiendo del subsistema multimedia elegido.

---

## 17.5. Escalado horizontal del audio ya codificado

### Fundamento

Codificar por oyente sería una multiplicación innecesaria. El sistema ya codifica por rendición: esa propiedad debe conservarse al escalar.

### Implementación conceptual

Un productor publica bloques con:

- Rendición.
- Generación.
- Secuencia.
- Duración.
- Configuración de arranque.

Varios distribuidores Bun consumen esos bloques y atienden sus propias conexiones.

La comunicación entre máquinas exige copiar y transportar datos; SharedArrayBuffer solo sirve dentro de los límites de memoria compartida admitidos.

### Impacto

Permite ampliar capacidad de conexiones y red sin duplicar toda la cadena multimedia por cliente.

### Riesgo

Hace falta resolver descubrimiento, asignación de clientes y recuperación. No debe presentarse como un balanceo mágico incorporado en Bun.

Las capacidades de puerto compartido y distribución entre procesos dependen del sistema operativo y de la versión, y deben verificarse.

---

# 18. Plan de validación: demostrar el salto sin esconder fallos detrás de la CPU media

## 18.1. Métricas imprescindibles

### Audio

- Tiempo hasta primer audio reproducible.
- Continuidad de muestras.
- Jitter de publicación.
- Duración real de crossfades.
- Underruns por causa.
- Latencia al borde en vivo.
- Recuperación tras pérdida de fuente.

### Runtime

- Retraso p50, p95, p99 y máximo del event loop.
- Duración de mezcla, codificación y publicación.
- Asignaciones por segundo.
- RSS, heap y memoria externa.
- Memoria de procesos multimedia por separado.
- Número de bloques retenidos.

### Distribución

- CPU por mil oyentes.
- Memoria incremental por oyente.
- Altas exitosas por segundo.
- Retraso por cliente.
- Expulsiones por causa.
- Tasa real de salida.

La latencia hasta el altavoz necesita instrumentación del cliente o pruebas acústicas. No puede inferirse únicamente de timestamps del servidor.

## 18.2. Casos de estrés obligatorios

1. **PCM fragmentado en posiciones arbitrarias:** verifica ensamblado de muestras.
2. **Ogg dividido byte a byte:** verifica parser y cabeceras.
3. **Clientes que no leen:** verifica límites y liberación.
4. **Avalancha de conexiones:** verifica admisión y prebuffer.
5. **Muerte del encoder Opus:** verifica aislamiento y generación.
6. **Muerte del master:** verifica detección de ausencia de salida.
7. **Disco lento o lleno:** verifica que catálogo y logs no bloqueen audio.
8. **Biblioteca con decenas de miles de archivos:** verifica reconciliación.
9. **Pista siguiente que tarda en abrir:** verifica READY.
10. **Directo durante un crossfade:** verifica arbitraje.
11. **Saltos del reloj civil:** verifica temporización monotónica.
12. **Prueba prolongada de 24–72 horas:** verifica deriva y crecimiento retenido.

Las pruebas de carga pueden implementarse con Bun y las de invariantes con bun:test, sin frameworks externos.

## 18.3. Comparaciones justas

FFI y FFmpeg deben compararse con:

- Mismo codec.
- Mismo bitrate.
- Mismo procesamiento.
- Mismo tamaño de entrada.
- Misma calidad.
- Misma carga HTTP.

Si un camino omite loudnorm, su menor CPU no demuestra que FFI sea responsable de toda la mejora.

---

# 19. Orden de ejecución recomendado

| Prioridad | Intervención | Resultado esperado |
|---|---|---|
| P0 | Corregir alineación PCM, arranque Opus e ICY | Audio válido y conexiones reproducibles |
| P0 | Cerrar administración y limitar entradas | Evitar control y consumo arbitrario de recursos |
| P0 | Sacar Bun.build de la petición y acotar logs | Eliminar interferencias evitables |
| P0 | Vigilar progreso de encoders y manejar errores de escritura | Evitar servidores “sanos” sin audio |
| P1 | Unificar cronología y consumo mediante FIFOs | Transiciones deterministas y sin replay |
| P1 | Introducir generaciones y arbitraje único | Reinicios y relevos coherentes |
| P1 | Separar audio, distribución y control | Aislar el audio del tráfico |
| P1 | Límites temporales por cliente y etapa | Memoria y retraso acotados |
| P2 | Ring indexado y publicación compartida por cursores | Escalabilidad más estable |
| P2 | Optimizar propiedad de buffers y eliminar copias redundantes | Menos memoria y presión de GC |
| P2 | Mejorar selección de rendición y batching | Menos tráfico y operaciones |
| P3 | Distribución horizontal y preparación adaptativa | Aumentar capacidad con evidencia |

---

# Conclusión

El código contiene ideas útiles: codificación por rendición, separación de mapas por tier, copia defensiva al publicar, sesiones de decks, prebuffer compartido y supervisión básica. Sin embargo, varias de esas ideas todavía no están conectadas mediante contratos consistentes de **tiempo, propiedad de memoria, formato y ciclo de vida**.

Los cambios con mayor capacidad transformadora son:

1. **Un único motor propietario de la línea temporal multimedia.**
2. **Separar el procesamiento de audio del fan-out y de la administración.**
3. **Distribuir publicaciones compartidas mediante consumo por demanda y cursores acotados.**
4. **Hacer que el arranque y los reinicios respeten realmente MP3, Ogg/Opus e ICY.**
5. **Controlar retraso y progreso por etapa, en lugar de contar chunks o procesos vivos.**
6. **Reducir bitrate y trabajo repetido antes de perseguir supuestos mecanismos internos del runtime.**

El objetivo técnicamente defendible no es “cero copias, cero buffering y millones de conexiones” como eslogan. Es construir un servidor donde **cada byte retenido tenga un propietario, cada muestra una posición temporal, cada cola un límite y cada fallo un dominio de aislamiento**.

Ese cambio de modelo es el que puede convertir este proyecto en una arquitectura de streaming de alto nivel con Bun: no una colección de optimizaciones aisladas, sino un sistema cuyo rendimiento siga siendo predecible precisamente cuando la red, los clientes, los discos o los encoders dejan de comportarse idealmente.