# 1. Punto de partida: reconstruir el servidor real, no el descrito en los comentarios

El código permite analizar una arquitectura concreta: una fuente de audio, un motor de reproducción y mezcla, uno o dos codificadores persistentes y un distribuidor HTTP que replica la salida entre los oyentes.

El recorrido principal es:

**Archivos o entrada SRT → decodificación a PCM → mezcla y transiciones en JavaScript → codificación MP3 y Opus → prebuffer → respuestas HTTP persistentes.**

Hay una decisión acertada: **la codificación se comparte entre oyentes**. No se codifica por conexión. Esa es una base importante para escalar.

Sin embargo, numerosas optimizaciones anunciadas en los comentarios no coinciden con el comportamiento del código:

- El FIFO de los decks no tiene activado el límite de memoria anunciado.
- La extracción de PCM sigue asignando un buffer nuevo.
- El decodificador nativo está implementado, pero no se utiliza al iniciar los decks.
- El pool MP3 presupone una frecuencia de codificación que el recorrido activo no garantiza.
- Los límites de las colas HTTP están expresados como si fueran bytes, pero actualmente cuentan fragmentos.
- El fundido hacia el directo intenta consumir un buffer que el deck activo no alimenta.
- La captura de cabeceras Opus confunde fragmentos de un pipe con unidades del contenedor Ogg.
- La compilación del frontend se ejecuta desde cada petición, sin una caché explícita del resultado.
- La selección del codificador nativo puede eliminar el procesamiento de audio solicitado.

Esto importa porque algunas mejoras aparentes no están simplemente incompletas: **se apoyan en invariantes que no existen y pueden provocar corrupción, crecimiento de memoria o interrupciones**.

## 1.1. Una precisión sobre “Bun vanilla sin dependencias”

El proyecto proporcionado no cumple literalmente esa descripción:

- Importa `mcp-lite`.
- Ejecuta FFmpeg y ffprobe.
- Carga bibliotecas compartidas de LAME y FFmpeg mediante FFI.

Bun ofrece transporte HTTP, streams, procesos, workers, FFI y utilidades de archivos. **No incorpora una plataforma completa de decodificación, codificación y recepción SRT de audio que sustituya esas bibliotecas.**

Por tanto, distinguiré dos ámbitos:

1. **Mejoras implementables con Bun y JavaScript, sin añadir dependencias:** distribución, colas, temporización, control, aislamiento, métricas, parsers de framing y gestión de recursos.
2. **Correcciones del subsistema multimedia existente:** conservando las dependencias nativas que ya utiliza el proyecto.

Si se exige eliminar también estas últimas, mantener todas las funciones actuales requeriría implementar codecs, contenedores y protocolos: sería otro proyecto, no una optimización razonable del servidor.

Tampoco hay que basar una propuesta en supuestas “fibers de Bun” o primitivas internas de multicast HTTP no documentadas. Las mejoras decisivas de este servidor pueden apoyarse en APIs públicas y contratos verificables.

---

# 2. Antes de optimizar: definir qué límites impone realmente una radio

En este sistema conviven tres costes diferentes:

1. **Coste por emisora:** decodificación, mezcla, DSP y codificación.
2. **Coste por oyente:** conexión, TLS si existe, estado, framing ICY, gestión de entrega y buffers.
3. **Coste físico de distribución:** bytes enviados por la red.

No deben confundirse.

A 320 kbit/s, sin contar sobrecargas:

| Oyentes | Salida MP3 |
|---:|---:|
| 500 | 160 Mbit/s |
| 5.000 | 1,6 Gbit/s |
| 10.000 | 3,2 Gbit/s |

A 96 kbit/s:

| Oyentes | Salida Opus |
|---:|---:|
| 500 | 48 Mbit/s |
| 5.000 | 480 Mbit/s |
| 10.000 | 960 Mbit/s |

Esto establece una frontera: **ninguna optimización del bucle JavaScript elimina el ancho de banda unicast por oyente**.

En cambio, sí pueden transformarse radicalmente:

- La memoria retenida por conexiones lentas.
- El número de operaciones JavaScript por segundo.
- La duración máxima de una pausa del plano de audio.
- La capacidad de recuperarse de fallos sin reiniciar la emisora.
- La cantidad de CPU desperdiciada por acoplamientos innecesarios.
- La latencia acumulada entre etapas.

El análisis debe orientarse a esas magnitudes, no a perseguir “cero asignaciones” como fin independiente.

---

# 3. Hallazgo crítico: el backpressure HTTP está medido en la unidad equivocada

## 3.1. Qué ocurre

En `http-server.ts` se crea un `ReadableStream` con un `highWaterMark` numérico, pero sin una función de tamaño basada en la longitud del fragmento.

En un stream predeterminado de este tipo, cada fragmento cuenta como una unidad.

Por tanto:

- El valor de 16.384 no significa 16 KiB.
- Significa aproximadamente 16.384 elementos encolados.
- El umbral del modo no low-latency también cuenta elementos, no bytes.

La misma confusión aparece en el decodificador nativo cuando compara `desiredSize` con una constante expresada en bytes.

## 3.2. Por qué es un problema transformador

Supongamos, solo como escenario ilustrativo, unos 48 fragmentos por segundo.

Un umbral de 16.384 fragmentos representa más de cinco minutos de producción. A 320 kbit/s, ese tiempo contiene aproximadamente 13,7 MB de audio por oyente, si los datos permanecen retenidos en esa cola.

Con 500 conexiones bloqueadas, el orden de magnitud potencial supera varios gigabytes.

El resultado exacto depende de cómo Bun drene la cola hacia sus buffers internos y el socket. Pero esa dependencia no salva el diseño: **la aplicación no está imponiendo el límite que cree imponer**.

Además, cinco “strikes” no tienen significado temporal estable:

- Cinco fragmentos pequeños pueden equivaler a unos milisegundos.
- Cinco fragmentos grandes pueden equivaler a varios segundos.

La política de expulsión cambia con la fragmentación del productor, no con el comportamiento real del oyente.

## 3.3. Cómo corregirlo en Bun vanilla

La base mínima es:

- Contabilizar las colas por bytes mediante una estrategia de tamaño adecuada.
- Definir límites también en tiempo de audio pendiente.
- Comprobar el presupuesto antes de seguir encolando.
- Diferenciar presión transitoria de incapacidad sostenida para consumir.
- Hacer explícito el tratamiento de la cancelación y del descarte.

Pero hay un punto más profundo: **`desiredSize` no mide cuánto audio ha escuchado el usuario ni cuánto ha confirmado TCP**.

Puede existir audio pendiente en:

- La cola del `ReadableStream`.
- Buffers internos de Bun.
- El socket del sistema operativo.
- El proxy intermedio.
- El reproductor.

Por eso el diseño debe reconocer qué nivel controla y qué niveles solo puede observar indirectamente.

## 3.4. Impacto esperado

Esta corrección no es una microoptimización:

- Convierte una memoria dependiente de pausas arbitrarias en memoria presupuestable.
- Evita que usuarios lentos comprometan a los rápidos.
- Hace que las expulsiones respondan a una política real de latencia.
- Permite estimar capacidad antes de saturar la máquina.

**Prioridad: inmediata.** Cualquier benchmark anterior a corregir esto puede estar midiendo acumulación de buffers en lugar de capacidad sostenida.

---

# 4. El salto arquitectónico principal: de “empujar a todos” a un registro compartido de audio

## 4.1. Debilidad del modelo actual

Cada fragmento provoca un recorrido por todos los oyentes y una llamada de encolado por destinatario.

Con dos tiers, cada difusión recorre además clientes que luego descarta por pertenecer al otro formato.

El coste crece con:

**número de oyentes × frecuencia de fragmentos.**

La aplicación mantiene también varias formas de retención:

- El prebuffer.
- Las colas de los oyentes.
- Los slots reutilizables de LAME.
- Los buffers internos del runtime.

No existe un único modelo de propiedad y de horizonte temporal del audio.

## 4.2. Propuesta: registro acotado por rendition con cursores por oyente

La salida de cada codificador debería publicarse en un registro circular de unidades de audio:

- Identificador de generación del codificador.
- Número de secuencia.
- Duración o posición temporal.
- Datos codificados inmutables.
- Información de sincronización y de inicialización cuando corresponda.

Cada oyente conserva principalmente:

- Un cursor de lectura.
- Su presupuesto de retraso.
- Su estado de protocolo, por ejemplo ICY.
- Su estado de cierre.

El consumidor obtiene una cantidad acotada de datos cuando su respuesta puede demandarlos. No se le añade indefinidamente cada nuevo fragmento solo porque el productor haya avanzado.

### El principio decisivo

**Un oyente lento no tiene derecho a retener indefinidamente la historia de la emisora.**

Cuando queda detrás de la ventana disponible, se aplica una política explícita:

- Desconexión y posterior reconexión.
- Resincronización, únicamente si el formato y el reproductor permiten hacerlo correctamente.
- Cambio de servicio mediante una nueva sesión, si el cliente lo soporta.

No debe saltarse arbitrariamente dentro de cualquier flujo comprimido.

## 4.3. Cómo hacerlo con APIs públicas

Es viable mediante:

- Arrays tipados para los datos.
- Un anillo de descriptores.
- Streams con producción guiada por demanda.
- Cursores independientes.
- Notificaciones acotadas cuando aparecen datos.
- Colecciones separadas por rendition y capacidades del cliente.

Hay que evitar sustituir un coste por otro: crear promesas, temporizadores o tareas por oyente y fragmento puede ser peor que el bucle original. La implementación debe mantener listas de consumidores realmente pendientes y procesarlas con presupuesto.

## 4.4. Qué mejora y qué no

La memoria de audio retenida por la aplicación puede aproximarse a:

- Una ventana compartida por rendition.
- Un estado pequeño por oyente.
- Una cantidad pequeña de datos en vuelo por respuesta.

Pero esto **no elimina**:

- Los buffers por conexión de Bun y del sistema operativo.
- El coste de enviar los bytes N veces.
- Todo el trabajo por oyente.

Es una reducción de retención y acoplamiento, no multicast mágico.

## 4.5. Por qué puede marcar un antes y un después

El prebuffer, la distribución y la política de lentitud pasan a compartir una misma abstracción temporal.

Eso permite responder de forma directa:

- Qué audio conserva el servidor.
- Qué generación está recibiendo cada oyente.
- Cuánto retraso admite.
- Cuándo deja de ser válido su cursor.
- Qué recursos consume una conexión bloqueada.

Esa capacidad de razonar con límites es una característica mucho más avanzada que simplemente disponer de un pool de buffers.

---

# 5. El “zero-copy” de LAME no tiene un contrato seguro de vida útil

## 5.1. El supuesto incorrecto

`LameEncoder` devuelve vistas de 128 slots reutilizables.

El comentario afirma que se reutilizan tras unos 128 segundos, basándose en una llamada de codificación por segundo. Pero el recorrido activo utiliza FFmpeg para los decks y entrega sus fragmentos conforme llegan.

No existe una normalización que garantice una llamada por segundo.

Si hubiera 48 llamadas por segundo, la vuelta completa del anillo tardaría aproximadamente 2,7 segundos, no 128.

Además:

- La política HTTP no limita actualmente el retraso en bytes.
- El prebuffer conserva vistas, no datos independientes.
- No hay confirmación de que todos los consumidores hayan dejado de referenciar un slot antes de sobrescribirlo.
- La rotación ocurre por llamada de codificación, incluso si la llamada no produce una cantidad significativa de salida.

## 5.2. Consecuencia

Un fragmento previamente encolado puede seguir apuntando a memoria que después contiene otro audio.

El fallo puede manifestarse como:

- Repeticiones.
- Saltos.
- Datos MP3 inválidos.
- Artefactos difíciles de reproducir.
- Diferencias entre oyentes rápidos y lentos.

Que Bun copie ciertos datos en una ruta concreta puede ocultar el problema. **No debe convertirse una observación de una versión en un contrato de propiedad que la API no establece.**

## 5.3. Alternativa de alto impacto: copiar una vez, compartir después

Para MP3 a 320 kbit/s, una copia de toda la salida de la emisora mueve unos 40 KB/s.

Comparar eso con el tráfico de cientos o miles de oyentes cambia la perspectiva: **una copia única por fragmento puede ser prácticamente irrelevante y eliminar una clase entera de corrupción**.

La solución más robusta suele ser:

- El codificador utiliza su scratch reutilizable.
- La salida publicada recibe almacenamiento estable.
- Todos los oyentes comparten ese fragmento inmutable.
- El registro temporal limita su retención.

Más adelante, si el perfil demuestra que esas asignaciones importan, puede diseñarse un pool con propiedad explícita. Pero no debe basarse solamente en “han pasado suficientes llamadas”.

## 5.4. El pool PCM presenta un problema relacionado

El comentario de `writeToMaster` presupone que escribir y hacer flush hace inmediatamente reutilizable el PCM.

Esa afirmación necesita contrastarse con el contrato real de `FileSink` en la versión desplegada y con los retornos de las operaciones. Un flush no debe interpretarse automáticamente como consumo completo por el proceso destino.

Con dos codificadores hay, además, dos consumidores potencialmente distintos.

### Impacto transformador

La verdadera mejora no es “más zero-copy”, sino:

**datos publicados inmutables, propiedad explícita y reutilización demostrablemente segura.**

Eso permite optimizar sin intercambiar memoria por corrupción silenciosa.

---

# 6. Separar el reloj de la emisora de los fragmentos de I/O

## 6.1. El problema central del motor de audio

Actualmente hay distintos relojes implícitos:

- El ritmo de salida de FFmpeg con lectura en tiempo real.
- La llegada de PCM desde SRT.
- Intervalos de 100 ms para silencio.
- `Date.now()` para transiciones.
- La resolución asíncrona de metadatos para fijar el comienzo del tema.

Un fragmento de un pipe no es una unidad temporal fiable. Puede contener:

- Una fracción de un frame PCM.
- Varias decenas de milisegundos.
- Una ráfaga acumulada durante una pausa.
- Una cantidad diferente según carga, plataforma o runtime.

El servidor utiliza esas fronteras accidentales para mezclar, codificar, distribuir y evaluar lentitud.

## 6.2. Propuesta: línea temporal única basada en muestras

El motor debería distinguir tres tiempos:

1. **Tiempo multimedia:** muestras emitidas o timestamps válidos de la fuente.
2. **Tiempo monotónico:** planificación local y medición de retrasos.
3. **Tiempo civil:** registros, interfaz y fechas.

Los fundidos deben avanzar por muestras mezcladas. El tiempo civil no debe decidir cuánto audio se ha reproducido.

La producción puede organizarse en bloques PCM de duración controlada y alineados a frames estéreo completos.

La duración óptima no es universal:

- Bloques pequeños reducen latencia de actuación, pero aumentan llamadas y overhead.
- Bloques grandes mejoran amortización, pero introducen ráfagas y peor respuesta.
- Los codecs y contenedores añaden sus propias granularidades.

El objetivo es elegirla mediante medición, no heredar la fragmentación del pipe.

## 6.3. Preservar restos, no descartar bytes

El camino LAME redondea hacia abajo la longitud a múltiplos de cuatro bytes y descarta el resto.

Si un límite de lectura cae dentro de un frame PCM, esos bytes no sobran: pertenecen a la siguiente unidad.

También existen riesgos al crear vistas `Int16Array` sobre offsets no alineados.

La ingestión necesita conservar residuos entre lecturas y producir exclusivamente frames completos. Esto es una corrección de integridad, no solo de rendimiento.

## 6.4. Control del jitter y del drift

Una entrada en directo necesita un buffer de jitter acotado, no una cola infinita.

Si la fuente y el consumidor tienen relojes ligeramente distintos, el buffer tenderá a vaciarse o llenarse aunque la red funcione bien. Hace falta distinguir:

- Jitter transitorio.
- Desajuste sostenido de reloj.
- Interrupción real.

Las correcciones de ritmo que requieran remuestreo deben apoyarse en el subsistema multimedia existente; eliminar muestras arbitrariamente no es una solución transparente.

Bun no ofrece garantías de tiempo real duro. Lo alcanzable es un motor de **tiempo real blando con plazos medidos, buffers acotados y degradación explícita**.

## 6.5. Impacto

- Fundidos de duración real estable.
- Menos dependencia de la fragmentación de red.
- Mejor control de ráfagas.
- Detección precisa de underruns.
- Una base temporal común para prebuffer, métricas y metadatos.

Este cambio afecta a prácticamente todo el comportamiento audible del servidor.

---

# 7. Los decks requieren una máquina de estados, no más booleanos

## 7.1. Debilidades concretas

### El límite PCM anunciado no se utiliza

`DECK_BUFFER_CAP_BYTES` se calcula, pero los decks construyen buffers sin pasar ese límite.

Un deck secundario iniciado antes de tiempo puede acumular audio durante mucho más de la ventana del crossfade.

Por ejemplo, la API de cola llama a `startFallback` aunque haya un deck activo. Eso puede iniciar el siguiente tema mucho antes de necesitarlo.

### Activar el límite tal como está tampoco basta

La política elimina fragmentos antiguos.

Para un deck que debe conservar el principio de la próxima canción, eso es semánticamente incorrecto: mantener los últimos segundos decodificados no equivale a precargar los primeros.

En archivos locales, al llenarse la precarga corresponde detener o ralentizar la lectura, no descartar el inicio. Para una fuente en directo puede ser razonable conservar lo más reciente. Son políticas distintas.

### El deck activo no alimenta el buffer usado para el fundido al directo

Mientras es primario, el PCM se envía al maestro, no se añade a su FIFO.

Al entrar el directo, el código intenta extraer fallback desde ese FIFO. En el caso normal estará vacío o no representará el punto actual.

Por tanto, el supuesto crossfade puede ser un fade-in del directo desde silencio.

### El relevo puede saltarse audio ya bufferizado

Al convertir el deck secundario en primario, comienza a utilizarse la nueva entrada del pipe, sin un mecanismo general que drene primero el audio pendiente de ese deck.

### Los metadatos globales se actualizan al preparar, no al emitir

La resolución de metadatos del próximo tema sobrescribe `state.currentTrack` aunque todavía suene el anterior.

Esto afecta a:

- Título visible.
- ICY.
- Duración restante.
- Momento del siguiente fundido.

### Las limpiezas asíncronas pueden afectar a una sesión nueva

El `finally` de un lector modifica el deck sin comprobar siempre que todavía corresponde a su propia instancia.

Un proceso antiguo puede finalizar después de que ese deck haya sido reutilizado. El temporizador de eliminación del deck saliente presenta un riesgo similar.

El booleano global `isStoppingFallback`, que vuelve a falso antes de terminar todas las limpiezas, no identifica qué instancia se está deteniendo.

## 7.2. Propuesta

Cada deck necesita una identidad de sesión o generación y estados explícitos:

- Preparación.
- Precarga.
- Listo.
- Reproducción.
- Transición.
- Drenaje.
- Detención.
- Fallo.

Todas las respuestas asíncronas deben pertenecer a una generación concreta:

- Metadatos.
- Fin de proceso.
- Lecturas.
- Temporizadores.
- Comandos de usuario.

El mezclador debe consumir fuentes a través de una interfaz coherente, tanto si son primarias como secundarias. No debería cambiar radicalmente la forma de leer una fuente cuando cambia su papel.

La información de tema se publica al alcanzar la posición de reproducción correspondiente, no al terminar ffprobe.

## 7.3. Por qué es una optimización de rendimiento

Estos errores generan trabajo desperdiciado:

- Decodificar un tema para acabar descartándolo.
- Procesos huérfanos o reiniciados innecesariamente.
- Escaneos y consultas repetidas.
- Reconexiones causadas por silencios.
- Acumulación PCM que no llegará a emitirse.

Eliminar estados inválidos puede ahorrar más recursos que acelerar el mezclador.

## 7.4. Precisión acústica adicional

El crossfade de potencia aproximadamente constante funciona bien para señales poco correlacionadas. **No garantiza ausencia de picos**.

Dos señales correlacionadas pueden sumar por encima del nivel nominal, y el clipping posterior introduce distorsión.

Además, usar una ganancia constante por fragmento produce escalones si los fragmentos son grandes. Una envolvente por muestra, o suficientemente fina, mejora la transición.

---

# 8. Compartir DSP y desacoplar las renditions sin degradar la emisora

## 8.1. La comparación FFI frente a FFmpeg no es equivalente

El comentario atribuye al cambio nativo la eliminación de un proceso con consumo elevado “con loudnorm”.

Pero el camino nativo omite ese DSP.

No se puede atribuir a FFI todo el ahorro cuando simultáneamente se elimina normalización y compresión dinámica.

Además, `startMasterEncoder` puede elegir LAME nativo aunque `audioProcessing` esté activado. El resultado es:

- MP3 sin ese tratamiento.
- Opus con tratamiento.
- Diferencias de sonoridad y dinámica entre tiers.

## 8.2. Procesar una vez, codificar varias veces

Si ambas salidas deben representar la misma emisora, el flujo correcto es conceptualmente:

**mezcla → DSP común → renditions.**

El procesamiento común se realiza una sola vez. Cada codificador aplica únicamente lo específico de su formato.

Para música de archivo, parte del análisis de sonoridad puede adelantarse y cachearse por versión del archivo. Un procesamiento offline medido puede evitar repetir estimaciones costosas durante la emisión, aunque no debe presentarse como equivalente automático a todo DSP dinámico en directo.

## 8.3. Evitar que un tier bloquee a otro

`writeToMaster` escribe primero al proceso Opus y luego al MP3. No hay una política explícita para el crecimiento de pendientes ni para fallos de escritura.

Cada rendition necesita:

- Cola de entrada limitada.
- Medición de avance de salida.
- Gestión de saturación.
- Supervisión.
- Reinicio con nueva generación.

Si un codificador no sostiene el ritmo, no debe retener indefinidamente al motor entero.

Tampoco corresponde descartar PCM a ciegas: eso comprime el tiempo de una rendition y rompe su continuidad. Ante saturación sostenida, puede ser preferible declarar esa rendition no disponible, reiniciarla y mantener las demás.

## 8.4. Codificar bajo demanda: útil, con condiciones

Mantener siempre ambos codificadores ofrece incorporación rápida, pero consume recursos cuando no hay oyentes en uno de los formatos.

Una política de encendido bajo demanda con histéresis puede ser rentable:

- No apagar ante una ausencia de unos segundos.
- Mantener el reloj y la programación.
- Preparar cabeceras y una ventana válida antes de aceptar oyentes.
- Medir el coste de arranque.

No sería mi primera optimización para una emisora activa, pero sí puede transformar un servicio con muchas emisoras y poca concurrencia por emisora.

---

# 9. La validez del formato debe gobernar prebuffer e incorporación tardía

## 9.1. Un pipe no entrega cabeceras de contenedor

`pipeOpus` busca `OpusHead` en una parte del fragmento y guarda el fragmento completo.

Eso no garantiza:

- Tener una página Ogg completa.
- Haber recibido `OpusTags`.
- No incluir también audio.
- Que la cabecera no estuviera dividida entre lecturas.
- Que el prebuffer comience en una frontera válida.

La ruta alternativa que conserva el primer fragmento pequeño tampoco establece ningún invariante del formato.

## 9.2. El reinicio conserva estado de una generación anterior

`opusHeaders` no se invalida al reiniciar el codificador.

Los prebuffers tampoco se coordinan explícitamente con generaciones.

Un oyente puede recibir cabeceras de un stream lógico y páginas de otro, con seriales y secuencias diferentes.

Eso no se soluciona aumentando el prebuffer.

## 9.3. Propuesta: ensamblado incremental de unidades multimedia

Para Ogg/Opus, el servidor necesita reconocer:

- Cabecera de página.
- Tabla de segmentos.
- Longitud completa.
- Continuación de paquetes.
- Serial del stream lógico.
- Secuencia.
- Posición granular.
- Páginas iniciales y cambios de generación.

No requiere decodificar Opus. Es framing de contenedor y resulta viable en JavaScript.

El punto de incorporación debe diseñarse y probarse con reproductores concretos. Reproducir cabeceras y saltar a páginas recientes no ofrece automáticamente una presentación correcta en todos ellos.

Cuando haga falta reconstruir un flujo lógico, también entran en juego seriales, posiciones, checksums, pre-skip y pre-roll. Eso ya es remultiplexación, no simplemente concatenar arrays.

## 9.4. MP3 tampoco admite cualquier corte sin consecuencias

Buscar una cabecera de frame es una mejora sobre empezar en un byte arbitrario, pero MP3 puede utilizar bit reservoir. Un frame inicial puede depender de datos anteriores.

Por tanto, una incorporación limpia puede requerir un margen de preroll, además de alineación.

Para otros formatos declarados:

- AAC necesita respetar el framing ADTS y su configuración.
- Vorbis necesita cabeceras apropiadas.
- FLAC requiere una estrategia de inicialización compatible con el cliente.

Actualmente `/mp3` puede servir formatos diferentes según configuración, pero el sistema de incorporación no está especializado para todos ellos.

## 9.5. Ventanas temporales, no un mismo número de bytes

Un prebuffer de 8.192 bytes representa aproximadamente:

- 205 ms a 320 kbit/s.
- 683 ms a 96 kbit/s.

Con bitrate variable, esa equivalencia fluctúa.

La retención debe definirse por duración, unidades válidas y generación, con un techo adicional de memoria.

### Impacto

- Menos conexiones que parecen establecidas pero no reproducen.
- Menos reconexiones por cabeceras inválidas.
- Arranque más consistente.
- Reinicios de codificador controlables.
- Latencia comparable entre renditions.

La incorporación tardía es una operación multimedia, no solo una operación de red.

---

# 10. ICY: un fallo de protocolo y una oportunidad de compartir trabajo

## 10.1. El framing se rompe cuando no hay título

Una vez anunciado `icy-metaint`, el flujo debe conservar la cadencia de bloques de metadatos, aunque el título esté vacío.

`chunkWithIcy` devuelve el audio directamente cuando no hay título. El cliente seguirá interpretando la posición esperada como longitud de metadatos.

Al pasar al directo, `currentTrack` se borra. Precisamente entonces puede desaparecer el framing ICY.

Esto puede corromper la interpretación del audio.

## 10.2. El prebuffer también rompe la cuenta

Al conectar se envía prebuffer sin pasar por la transformación ICY ni ajustar `bytesSinceMeta`.

Después, el framing empieza a contar desde cero.

El cliente cuenta desde el principio de la respuesta. Servidor y cliente dejan de compartir la misma posición.

## 10.3. Coste innecesariamente replicado

El título se construye dentro del recorrido de oyentes y el bloque de metadatos se codifica repetidamente para cada conexión.

Además, algunas divisiones de audio usan copias donde bastaría una vista de almacenamiento inmutable.

## 10.4. Diseño propuesto

- Mantener la cadencia ICY incluso sin título.
- Aplicar el mismo framing desde el primer byte de prebuffer.
- Emitir correctamente los bloques vacíos cuando proceda.
- Cachear el bloque de metadatos por versión de título.
- Asociar el título a la posición multimedia, no solo al estado global actual.
- Usar vistas seguras sobre fragmentos inmutables.

Una optimización posterior sería formar cohortes de oyentes con la misma fase ICY, siempre que su incorporación y su prebuffer lo permitan. Así podría compartirse parte de la segmentación.

No es necesario empezar por cohortes: la caché de metadatos y la eliminación de copias redundantes ya ofrecen una mejora limpia.

### Impacto transformador

Se preserva el formato durante cambios entre música y directo, al mismo tiempo que se reduce un coste que escala por oyente.

---

# 11. Eliminar interferencias: separar plano de audio, distribución y control

## 11.1. El event loop ejecuta trabajos que no deberían competir

El mismo entorno atiende o coordina:

- Difusión de audio.
- Llamadas FFI síncronas.
- Operaciones síncronas de archivos.
- Escaneos recursivos.
- Serialización de cachés.
- Escritura de logs.
- Construcción del frontend.
- Peticiones administrativas.
- Consultas de métricas.

Una pausa de control puede convertirse en una pausa de toda la emisora.

### Logs

Cada evento habilitado añade datos de forma síncrona a dos archivos.

Una tormenta de conexiones produce múltiples escrituras bloqueantes por alta y baja. El disco pasa a formar parte del camino crítico de audio.

### Escaneo

Se recorre el árbol cada cinco segundos con operaciones síncronas.

La reconciliación utiliza búsquedas repetidas sobre arrays, con comportamiento potencialmente cuadrático.

### Caché de metadatos

Cada modificación puede serializar y reescribir toda la caché de forma síncrona.

### Frontend

La ruta de JavaScript invoca `Bun.build` en cada petición. No hay una caché explícita del artefacto ni una deduplicación de compilaciones concurrentes.

Aunque parte del trabajo de Bun ocurra fuera del hilo JavaScript, sigue compitiendo por CPU y memoria.

## 11.2. Propuesta de aislamiento

Separaría:

1. **Motor de audio:** reloj, fuentes, transiciones, salud multimedia.
2. **Distribución:** registros codificados y conexiones.
3. **Control:** archivos, administración, metadatos, UI y logs.

Puede hacerse con Workers y procesos Bun, sin frameworks.

No es obligatorio comenzar con tres procesos. La primera separación de gran valor suele ser:

- Retirar logs y escaneos del plano caliente.
- Retirar codificación síncrona pesada del hilo que sirve conexiones.
- Servir artefactos frontend ya construidos.

### Workers frente a procesos

- Los workers permiten separar trabajo JavaScript y, cuando procede, compartir memoria.
- Un fallo nativo de memoria puede derribar el proceso entero, aunque ocurra en un worker.
- Los procesos proporcionan una frontera de fallo más fuerte.

Para FFI experimental, esa diferencia es importante.

## 11.3. Mejoras específicas sin sobrediseño

- Logs asíncronos por lotes, con cola limitada, rotación y política de descarte.
- Caché de metadatos con escrituras agrupadas y reemplazo atómico.
- Inventario incremental de archivos.
- Reconciliación periódica como respaldo, no escaneo completo agresivo.
- Uso de conjuntos para altas y bajas.
- Tratamiento explícito de enlaces simbólicos y árboles enormes.
- Paginación de listados administrativos.
- Archivos estáticos mediante `Bun.file`, sin convertirlos innecesariamente a texto.
- Compilación de frontend al desplegar o al cambiar el contenido.

## 11.4. Impacto

La ganancia principal no es necesariamente una reducción espectacular de CPU media: es una reducción de las **colas de latencia**.

Una emisora puede consumir poca CPU y aun así cortar audio porque una operación ocasional bloquea 200 ms.

En streaming, estabilizar el peor comportamiento razonable suele importar más que acelerar la operación promedio.

---

# 12. FFI: acelerar llamadas no equivale a diseñar una ruta nativa segura

## 12.1. El decodificador nativo no participa en el recorrido activo

`startFallback` siempre utiliza FFmpeg.

Por ello, optimizar `NativeDecoder` no cambia la reproducción actual hasta integrarlo. La configuración `useNativeDecode` no selecciona realmente ese camino.

Su existencia tampoco justifica las hipótesis de frecuencia usadas por el pool LAME.

## 12.2. Riesgos críticos antes de activarlo

### ABI por offsets fijos

Se accede a estructuras de FFmpeg mediante offsets numéricos y se prueban varias versiones mayores.

Que una biblioteca cargue no demuestra que sus estructuras tengan el layout esperado.

Un error aquí puede producir una lectura arbitraria o un fallo nativo. No es una excepción JavaScript recuperable.

### Capacidad de salida comunicada incorrectamente

En el remuestreo se ofrece una capacidad de salida fija sin ajustarla siempre al espacio restante del buffer desde el puntero de escritura actual.

Una comprobación después de la escritura no evita un posible desbordamiento nativo.

### Gestión de paquetes y backpressure del decoder

- Los paquetes de otros streams no se liberan en el camino de descarte mostrado.
- Si el envío devuelve `EAGAIN`, el paquete debe conservarse para reintento según el contrato de la biblioteca; liberarlo y continuar puede perder audio.
- El drenaje del decoder y del remuestreador no está completado de forma robusta.
- Un resultado parcial puede interpretarse prematuramente como final.

### Limpieza incompleta

Si la apertura falla a mitad de camino, pueden quedar recursos nativos adquiridos.

Si el bucle lanza una excepción, la liberación final no está protegida por una estructura de limpieza que garantice ejecutarse.

### Cancelación e I/O síncrono

Abrir, inspeccionar y leer mediante FFI puede bloquear el hilo. Una espera síncrona nativa no se vuelve cancelable porque exista un booleano en JavaScript.

### Supuestos de plataforma y runtime

Las afirmaciones de los comentarios sobre fallos de memoria de una versión concreta de Bun, equivalencia entre versiones de FFmpeg o liberación automática de grandes asignaciones necesitan reproducciones verificables. No deben tratarse como hechos generales.

## 12.3. Recomendación

No activaría este decoder como optimización inmediata.

Primero:

- Fijar una combinación concreta y validada de arquitectura y ABI.
- Rechazar combinaciones no verificadas.
- Validar cada retorno.
- Garantizar limpieza parcial y final.
- Corregir capacidad de buffers.
- Implementar cancelación y drenaje.
- Ejecutar pruebas con archivos truncados, corruptos y multistream.
- Aislarlo si el riesgo nativo sigue siendo alto.

Bajo la restricción de no añadir componentes nativos, no propondría un shim nuevo como solución inmediata. Mantener FFmpeg como frontera de proceso es una alternativa legítima.

## 12.4. Dónde sí puede aportar FFI

LAME expone una API mucho más manejable basada en un contexto opaco.

Puede ahorrar IPC y memoria de proceso, pero sigue realizando el trabajo de codificación. Si lo hace síncronamente en el hilo HTTP, la mejora de throughput multimedia puede empeorar la latencia de las conexiones.

El resultado debe compararse con parámetros y DSP equivalentes.

**El criterio avanzado no es “menos procesos”, sino “menos coste total con mejor aislamiento y plazos más estables”.**

---

# 13. Supervisión: un proceso existente no implica audio disponible

## 13.1. `stderr` sin drenaje puede parar el audio

Numerosos procesos usan `stderr` en modo pipe sin consumidor visible.

Si FFmpeg emite suficientes avisos, ese pipe puede llenarse y bloquear al proceso.

Esto puede suceder justo cuando hay una fuente defectuosa, que es cuando más necesita recuperarse el servidor.

La salida de diagnóstico debe:

- Drenarse continuamente.
- Limitarse en memoria.
- Agruparse o muestrearse.
- No generar a su vez escrituras síncronas por línea.

## 13.2. Falta detección de fuente estancada

La validación de audio sostenido depende del tiempo entre el primer fragmento y uno posterior.

Pero una lectura bloqueada no produce necesariamente fragmentos vacíos. El contador no detecta adecuadamente una fuente que deja de entregar audio manteniendo la conexión.

Debe medirse:

- Última muestra válida recibida.
- Audio recibido por ventana temporal.
- Avance del timestamp multimedia.
- Duración de huecos.
- Estado del proceso y estado de salida por separado.

## 13.3. El codificador puede morir sin reinicio oportuno

Los callbacks ponen el proceso a nulo, pero no existe un supervisor independiente que asegure la recuperación mientras la fuente sigue emitiendo.

La consecuencia posible es un sistema que continúa “en directo” sin salida codificada.

## 13.4. SRT necesita configuración y expectativas correctas

El comentario “UDP, 0-RTT, sin HOL” simplifica demasiado:

- SRT tiene establecimiento de conexión.
- Su fiabilidad implica retransmisiones.
- El búfer de latencia y los plazos de entrega forman parte esencial del protocolo.
- UDP no elimina por sí solo esperas por paquetes perdidos.

Además, en la interfaz SRT habitual de FFmpeg, esos parámetros de latencia se expresan en microsegundos. Un valor de 20 no representa 20 ms.

Debe verificarse la semántica de la versión desplegada y dimensionar la latencia según RTT, jitter y pérdida. Un presupuesto de recuperación irrealista puede empeorar drásticamente el audio.

El `streamid` anunciado tampoco aparece validado explícitamente por la aplicación como autenticación. No debe darse por hecho que una cadena mostrada al usuario protege la entrada.

## 13.5. Propuesta de supervisor multimedia

Cada etapa necesita estados y condiciones de salud:

- Proceso iniciado.
- Entrada válida.
- Salida válida.
- Ritmo suficiente.
- Cola dentro de presupuesto.
- Generación coherente.

Los reinicios deben tener:

- Backoff.
- Jitter.
- Límite de frecuencia.
- Protección contra reinicios simultáneos.
- Política para oyentes de una generación inválida.

La salud debe basarse en **avance de audio válido**, no solo en referencias a procesos.

### Impacto

Se pasa de “esperar que los callbacks encajen” a un sistema capaz de recuperarse de forma acotada y observable.

---

# 14. Seguridad y admisión son parte del rendimiento

## 14.1. El plano administrativo está expuesto

El servidor escucha por defecto en todas las interfaces y permite sin autenticación operaciones como:

- Cambiar la carpeta.
- Añadir entradas a la cola.
- Saltar.
- Detener el proceso.

Ambos puertos utilizan el mismo handler, por lo que separar puertos no separa realmente las capacidades expuestas.

También hay operaciones que aceptan rutas o URLs, con riesgos de:

- Acceso a recursos no previstos.
- SSRF a través del subsistema multimedia.
- Escaneos costosos.
- Colas sin límite.
- Reinicios repetidos.

CORS no sustituye autenticación.

## 14.2. No basta `maxListeners`

El número máximo de oyentes no limita:

- Sockets que aún no han llegado a una ruta de streaming.
- Peticiones administrativas.
- Compilaciones.
- Cuerpos de petición.
- Sesiones MCP.
- Descriptores abiertos por otras rutas.
- Tasa de altas y bajas.

Desactivar globalmente el timeout de inactividad también requiere límites compensatorios.

## 14.3. Admisión por presupuesto

La capacidad debería calcularse considerando:

- Oyentes por rendition.
- Bitrate real.
- Ancho de banda libre.
- Memoria por conexión.
- Ritmo de nuevas conexiones.
- Tiempo de handshake, si hay TLS.
- Retraso del event loop.
- Salud de los codificadores.

Un límite dinámico puede rechazar antes de que el servicio se degrade para todos.

Es viable con contadores agregados y políticas simples. No hace falta un modelo de inteligencia artificial ni una heurística opaca.

## 14.4. Tormentas de reconexión

Si miles de clientes se desconectan simultáneamente y vuelven a intentar juntos:

- Se concentra el trabajo de inicialización.
- Se envían muchos prebuffers a la vez.
- Se dispara el logging.
- Puede volver a saturarse el servidor.

Hay que presupuestar el **coste de incorporación**, no solo el de mantener una conexión estable.

No todos los reproductores respetarán instrucciones de reintento. Por eso la limitación de admisión debe existir en el servidor.

También debe evitarse confiar en `X-Forwarded-For` salvo que la petición proceda de un proxy autorizado; de lo contrario, los límites por IP son fácilmente eludibles.

---

# 15. Escalabilidad multinúcleo sin multiplicar codecs

## 15.1. El siguiente cuello de botella

Después de corregir memoria y control, el fan-out JavaScript puede saturar un núcleo.

La solución no debería ser replicar toda la emisora en cada worker, porque eso multiplica:

- Decodificación.
- Mezcla.
- Codificación.
- Estados de playlist.
- Problemas de sincronización.

## 15.2. Propuesta: un motor, varios distribuidores

Mantener:

- Una producción codificada por rendition.
- Varios distribuidores Bun.
- Un subconjunto de oyentes por distribuidor.

Los datos que cruzan entre motor y distribuidores deben ser preferentemente los ya comprimidos.

A 320 kbit/s, replicar la salida a unos pocos distribuidores tiene un coste pequeño frente a replicarla a miles de oyentes.

Se puede utilizar:

- Mensajería entre workers.
- Memoria compartida con control correcto de publicación.
- IPC local entre procesos.
- Transporte local Bun para distribuir audio codificado.

La memoria compartida exige disciplina:

- Datos completos antes de publicar el descriptor.
- Generaciones y secuencias.
- Prohibición de sobrescribir unidades todavía válidas.
- Ninguna espera bloqueante en el hilo HTTP.

Para distribuir conexiones entre procesos mediante reutilización de puerto, debe verificarse el soporte de Bun y del sistema operativo concretos. No es una garantía portable.

## 15.3. Escalado entre máquinas

Cuando el límite es la NIC:

- El origen entrega una copia por rendition a cada nodo distribuidor.
- Cada nodo atiende su audiencia.
- Las generaciones, el framing y las ventanas de incorporación deben mantenerse coherentes.

Esto es factible con servicios Bun sin frameworks.

No convierte la salida en O(1) para toda la infraestructura: desplaza y reparte el coste de distribución.

## 15.4. ¿Segmentos HTTP?

Si el producto tolera más latencia y dispone de un cliente compatible, los segmentos compartidos pueden mejorar cacheabilidad y distribución.

Pero:

- Cambian el modelo de reproducción.
- No equivalen a los endpoints continuos actuales.
- Requieren empaquetado y manifests correctos.
- No ofrecen latencia ultrabaja automáticamente.
- Servirlos con `Bun.file` no garantiza zero-copy bajo todas las condiciones, especialmente con TLS.

Es una opción de producto y arquitectura, no una optimización transparente.

---

# 16. Reducir trabajo por oyente sin inventar multicast HTTP

Antes de introducir distribución multiproceso, hay mejoras locales de alto retorno:

### Separar clientes por rendition

Evita recorrer todos los clientes en cada emisión de MP3 y Opus.

### Mantener contadores incrementales

Cada nueva conexión construye actualmente un array con todos los clientes para contar Opus. También lo hacen varias rutas de métricas.

En una oleada de altas, el trabajo acumulado puede acercarse a un patrón cuadrático.

Los contadores por tier deben actualizarse al entrar y salir, con cierre idempotente.

### Agregar fragmentos con presupuesto de latencia

Si el codificador produce fragmentos muy pequeños, una agregación controlada puede reducir:

- Llamadas de encolado.
- Trabajo de framing.
- Overhead del runtime.
- Número de iteraciones de fan-out.

Pero cada agregación añade demora. Debe existir un máximo temporal, no solo un tamaño objetivo.

### Evitar trabajo idéntico dentro del bucle

- Título actual.
- Bloques ICY.
- Atributos de rendition.
- Cálculos agregados.
- Logs detallados.

### Presupuestar la duración del reparto

Un recorrido muy grande puede monopolizar el hilo.

Dividirlo en lotes puede mejorar equidad con otras tareas, siempre que:

- Se conserve el orden por cliente.
- No se cree una tarea por destinatario y fragmento.
- Se limite el desfase entre el primer y el último oyente del lote.
- No se retrase la ingestión.

Estas mejoras disminuyen el coste constante de O(N), que sigue existiendo.

Las APIs de publicación WebSocket de Bun solo serían relevantes si se cambiara el protocolo y el cliente. No aceleran automáticamente respuestas HTTP de audio existentes.

---

# 17. Observabilidad: medir audio válido y colas, no solo bytes “enviados”

## 17.1. Los contadores actuales inducen a error

`bytesSent` aumenta al encolar.

Eso no significa:

- Entregado a la red.
- Confirmado por TCP.
- Recibido por el reproductor.
- Reproducido.

Además:

- El prebuffer no se cuenta.
- Las cabeceras Opus no se cuentan.
- Los bytes ICY no se cuentan.
- La entrada contabilizada es PCM decodificado, no tráfico SRT real.
- El detector de bitrate registra el resultado, pero su callback no actualiza los campos correspondientes de `state`.
- La salud del master no contempla correctamente el codificador nativo.
- `sourceConnected` se activa al lanzar el proceso, antes de demostrar conexión o audio.

Un panel puede mostrar normalidad mientras no existe salida útil.

## 17.2. Métricas que sí revelarían los límites

### Motor de audio

- Muestras producidas por intervalo.
- Último avance multimedia.
- Underruns y overruns.
- Duración real de transiciones.
- Ocupación de buffers PCM.
- Desfase entre reloj monotónico y tiempo de audio.

### Codificación

- Tiempo por llamada o bloque.
- Audio pendiente de codificar.
- Último frame válido emitido.
- Bitrate observado por ventana.
- Reinicios y generaciones.
- CPU y memoria por proceso o worker.

### Distribución

- Retraso de cursor por oyente.
- Bytes pendientes controlados por la aplicación.
- Percentiles de duración del fan-out.
- Tiempo entre publicación y entrega al runtime.
- Expulsiones por motivo.
- Tiempo de incorporación.
- Tasa de conexiones y cancelaciones.

### Infraestructura

- RSS del conjunto completo, no solo del proceso Bun.
- Heap y memoria externa por separado.
- Descriptores.
- Buffers y presión de sockets cuando puedan observarse.
- Throughput de red.
- Retardo del event loop.

No debe asignarse una serie de métricas a cada UUID de oyente: esa cardinalidad puede convertirse en otro problema de memoria.

## 17.3. Medir lo que oye el usuario

Para validar latencia extremo a extremo hacen falta receptores de prueba.

Pueden introducirse señales o marcas temporales controladas en una fuente sintética y medir su llegada o reproducción. Medir solo el tiempo de `enqueue` no caracteriza una radio.

---

# 18. Casos de estrés que deberían guiar la transformación

## Caso A: conexiones que dejan de leer

**Ensayo:** mezclar consumidores normales, consumidores muy lentos y sockets que apenas progresan.

**Debe demostrarse:**

- Memoria estabilizada.
- Cola por oyente limitada.
- Expulsión predecible.
- Ausencia de corrupción tras varias vueltas del pool.
- Ninguna degradación significativa en oyentes rápidos.

---

## Caso B: entrada SRT conectada pero sin audio

**Ensayo:** detener el avance multimedia sin cerrar inmediatamente el transporte.

**Debe demostrarse:**

- Detección por ausencia de muestras válidas.
- Retorno a fallback dentro del presupuesto definido.
- No depender del cierre de stdout.
- Recuperación sin bucles de flapping.

---

## Caso C: comandos simultáneos durante un crossfade

**Ensayo:** saltar, modificar fuente, añadir cola y desconectar el directo en ventanas próximas.

**Debe demostrarse:**

- Una generación antigua no modifica una nueva.
- No quedan procesos huérfanos.
- Los metadatos corresponden al audio emitido.
- Nunca hay dos productores no coordinados alimentando el maestro.

---

## Caso D: biblioteca enorme y disco lento

**Ensayo:** decenas de miles de archivos, cambios continuos, almacenamiento con latencia y rotación de logs.

**Debe demostrarse:**

- Sin pausas audibles por escaneo.
- Reconciliación acotada.
- Persistencia de metadatos sin bloquear audio.
- Logs que no detienen FFmpeg ni llenan memoria.

---

## Caso E: reinicio del codificador Opus con oyentes activos

**Debe demostrarse:**

- Cabeceras y audio pertenecen a la misma generación.
- No se reutiliza prebuffer anterior de forma inválida.
- Incorporación tardía válida.
- Política explícita para conexiones existentes.
- MP3 sigue funcionando si solo falla Opus.

---

## Caso F: miles de conexiones nuevas en pocos segundos

**Debe demostrarse:**

- Admisión gradual.
- Sin conteos O(N) por alta.
- Sin compilaciones repetidas.
- Sin tormenta de logs síncronos.
- Prebuffer presupuestado.
- Los oyentes establecidos tienen prioridad sobre altas nuevas.

---

## Caso G: archivos corruptos y ABI incompatible

**Debe demostrarse:**

- No hay crecimiento acumulativo de recursos.
- Los fallos se clasifican y no provocan reintentos infinitos.
- El decoder nativo rechaza entornos no validados.
- Una entrada defectuosa no derriba todos los distribuidores.

---

## Caso H: ejecución prolongada

Una prueba de pocos minutos no valida una emisora 24/7.

Deben realizarse pruebas de muchas horas con:

- Cambios de fuente.
- Reinicios.
- Cancelaciones.
- Rotación de logs.
- Archivos añadidos y retirados.
- Conexiones lentas.
- Cambios de generación.

El objetivo es comprobar que memoria, descriptores y procesos convergen a una meseta, no que “todavía no se ha agotado la RAM”.

---

# 19. Orden de ejecución recomendado

| Prioridad | Cambio | Motivo |
|---|---|---|
| **P0** | Corregir unidades de backpressure y propiedad del audio MP3 | Evita memoria descontrolada y corrupción |
| **P0** | Reparar ICY y la incorporación Opus por generaciones | Garantiza streams interpretables |
| **P0** | Drenar `stderr` y supervisar avance real de audio | Evita bloqueos silenciosos |
| **P0** | Autenticar y limitar administración | Evita interrupciones triviales y abuso de recursos |
| **P1** | Máquina de estados con identidades de sesión | Elimina carreras y trabajo desperdiciado |
| **P1** | Reloj por muestras y PCM correctamente ensamblado | Estabiliza reproducción y transiciones |
| **P1** | Sacar logs, escaneos y compilación del camino crítico | Reduce pausas globales |
| **P1** | Hacer coherente el DSP entre renditions | Corrige semántica y evita procesamiento duplicado |
| **P2** | Registro compartido con cursores por oyente | Hace predecible la memoria y el retraso |
| **P2** | Colecciones separadas, contadores y batching medido | Reduce coste por oyente |
| **P2** | Distribuidores multinúcleo | Escala sin multiplicar codecs |
| **P3** | FFI adicional, memoria compartida avanzada o segmentación | Solo después de medir y estabilizar invariantes |

Hay también correcciones menores que conviene integrar:

- Validar rangos reales de configuración y permitir duraciones fraccionarias donde corresponda: el valor de 0,2 segundos funciona como predeterminado, pero el parser de enteros lo rechazaría si se introduce explícitamente por entorno.
- Evitar dependencias circulares entre configuración, formatos y logger durante inicialización; el camino de error puede intentar usar configuración aún no inicializada.
- No cambiar silenciosamente puertos dejando URLs y configuración inconsistentes.
- Unificar la acción de salto entre API y MCP.
- Hacer que una carpeta inicialmente vacía pueda pasar a estado operativo al recibir archivos.
- Implementar un apagado real: dejar de aceptar conexiones, detener productores, drenar con plazo, liberar recursos y después terminar.
- No tratar `uncaughtException` como permiso para seguir indefinidamente con un estado multimedia potencialmente inconsistente.

---

# Conclusión: dónde está el cambio verdaderamente radical

Después de reconstruir el recorrido y sus contratos, las mayores oportunidades no están en una API secreta de Bun ni en reducir dos operaciones matemáticas del crossfade.

Están en cinco cambios de modelo:

1. **Pasar de fragmentos accidentales a una línea temporal multimedia explícita.**
2. **Pasar de colas por empuje y límites ambiguos a ventanas compartidas con presupuestos verificables.**
3. **Pasar de buffers reutilizados por intuición a propiedad e inmutabilidad demostrables.**
4. **Pasar de booleanos y callbacks cruzados a generaciones y máquinas de estados.**
5. **Pasar de un único plano interferido por todo a producción, distribución y control aislados.**

Sobre esa base, Opus puede reducir drásticamente el coste de red; varios distribuidores Bun pueden aprovechar los núcleos; y FFI puede reducir overhead donde el perfil lo justifique.

Pero el antes y el después más importante sería este:

**que el servidor deje de depender de cuánto tarda en fallar una cola, un proceso o un buffer, y pase a garantizar cuánto audio retiene, cuánto retraso admite, qué ocurre al superar cada presupuesto y cómo continúa emitiendo cuando una parte falla.**

Esa es una base técnicamente sólida para un servidor de radio de referencia: no prometer recursos ilimitados, sino convertir cada límite en una propiedad explícita, medible y controlada.