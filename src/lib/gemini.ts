import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Identifica a la materia y sirve como anclaje en la UI
 * (panel de Configuración muestra este string).
 */
export const ASSISTANT_LABEL =
  "Asistente 14 Ver. 2.2 — Sociología (Cód. 14, Cátedra Pablo Roma — CBC - UBA)";

/**
 * Base de conocimiento de la materia: PDFs servidos como archivos
 * estáticos en `public/` y subidos a Gemini File API en runtime.
 *
 * El modelo NO debe responder con nada que no esté en estos dos PDFs.
 * Se suben a Gemini File API una sola vez por sesión y se referencian
 * por fileUri (cache 24 h en localStorage).
 */
const VITE_BASE_URL: string =
  ((import.meta as ImportMeta & { env: Record<string, string | undefined> }).env?.BASE_URL ?? "/");

const PDF_SOURCES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "01.U1_2_FULL.pdf", path: `${VITE_BASE_URL}01.U1_2_FULL.pdf` },
  { name: "02.U3_4_FULL.pdf", path: `${VITE_BASE_URL}02.U3_4_FULL.pdf` },
] as const;

/**
 * Cache en localStorage: para cada PDF guardamos { uri, expiry }.
 * TTL: 24h (la File API de Gemini expira a las 48h, dejamos margen).
 */
const KB_CACHE_PREFIX = "gem-pdf-uri:";
const KB_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedUri {
  uri: string;
  expiry: number;
}

function readCachedUri(name: string): string | null {
  try {
    const raw = localStorage.getItem(KB_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedUri;
    if (!parsed?.uri || !parsed?.expiry) return null;
    if (parsed.expiry < Date.now()) return null;
    return parsed.uri;
  } catch {
    return null;
  }
}

function writeCachedUri(name: string, uri: string): void {
  try {
    const payload: CachedUri = { uri, expiry: Date.now() + KB_TTL_MS };
    localStorage.setItem(KB_CACHE_PREFIX + name, JSON.stringify(payload));
  } catch {
    /* sin persistencia: se re-subirá cada vez */
  }
}

/**
 * Sube un PDF a Gemini File API y devuelve el fileUri.
 * Si ya hay uno cacheado en localStorage (no expirado), lo reusa.
 */
async function ensurePdfUploaded(
  ai: GoogleGenAI,
  name: string,
  path: string
): Promise<string> {
  const cached = readCachedUri(name);
  if (cached) return cached;

  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${name} desde el sitio (HTTP ${res.status}).`);
  }
  const blob = await res.blob();
  if (blob.size === 0) {
    throw new Error(`El archivo ${name} está vacío.`);
  }

  const uploaded = await ai.files.upload({
    file: new File([blob], name, { type: "application/pdf" }),
    config: { displayName: name },
  });
  const uri = uploaded?.uri;
  if (!uri) {
    throw new Error(`No se pudo subir ${name} a Gemini File API.`);
  }
  writeCachedUri(name, uri);
  return uri;
}

/**
 * Prepara la base de conocimiento: sube los PDFs declarados en
 * `PDF_SOURCES` a Gemini File API (o reutiliza los URIs cacheados)
 * y devuelve un array de `fileData` listo para meter en `parts[]`.
 *
 * Si `PDF_SOURCES` está vacío, lanza un error claro para que el
 * usuario sepa que falta cargar el material antes de usar la app.
 */
async function buildKnowledgeBaseParts(
  ai: GoogleGenAI,
  onProgress?: (msg: string) => void
): Promise<{ fileData: { fileUri: string; mimeType: string } }[]> {
  if (PDF_SOURCES.length === 0) {
    throw new Error(
      "La base de conocimiento está vacía. Copiá los PDFs a public/ y " +
        "registralos en PDF_SOURCES dentro de src/lib/gemini.ts."
    );
  }
  const parts: { fileData: { fileUri: string; mimeType: string } }[] = [];
  for (const src of PDF_SOURCES) {
    onProgress?.(`Subiendo ${src.name} a Gemini…`);
    const uri = await ensurePdfUploaded(ai, src.name, src.path);
    parts.push({ fileData: { fileUri: uri, mimeType: "application/pdf" } });
  }
  return parts;
}

/**
 * Prompt del sistema — Tutor 14 Ver. 2.2, materia "Sociología"
 * (Código 14, Cátedra Pablo Roma — Ciclo Básico Común, UBA).
 */
export const SYSTEM_PROMPT = `# SYSTEM PROMPT: EXPERTO TUTOR ACADÉMICO
## Sociología (Cátedra: Pablo Roma - Código 14 - CBC - UBA)

### 1. IDENTIDAD Y PROPÓSITO
Eres un Tutor de Inteligencia Artificial especializado de forma exclusiva en la materia Sociología (Cátedra: Pablo Roma, Código 14) del Ciclo Básico Común (CBC) de la Universidad de Buenos Aires (UBA). Tu misión es asistir a los estudiantes en la comprensión conceptual profunda, la articulación de problemas teóricos clásicos y contemporáneos, el análisis sociohistórico de los modelos de acumulación y la preparación rigurosa tanto del Primer Parcial (Unidades 1 y 2) como del Segundo Parcial (Unidades 3 y 4), reproduciendo con exactitud la perspectiva crítica, histórica y materialista que vertebra a la cátedra.

### 2. FUENTES DE INFORMACIÓN: GUÍA VS. BASE DE CONOCIMIENTOS
Debes diferenciar de forma taxativa la función de los documentos de trabajo:
- Guía Metodológica y Pedagógica (Programa Oficial de la Cátedra Roma): Funciona como brújula pedagógica y evaluativa. Fija los objetivos formativos, las condiciones histórico-sociales de producción teórica y la exigencia de un análisis crítico que supere la mera reproducción informativa del sentido común.
- Base de Conocimientos Exclusiva (Los 2 Archivos PDF de la Cátedra): Toda categoría, cita y desarrollo conceptual debe emanar estricta y únicamente de los dos archivos de lectura obligatoria:
  * 01.U1_2_FULL.pdf (Primer Parcial - Unidades 1 y 2): Desnaturalización de la vida cotidiana y contingencia social (Marqués); filosofía espontánea, sentido común, inventario histórico y hegemonía (Gramsci); sociología reflexiva, monismo metodológico y conocimiento como conciencia frente al positivismo (Sameck/Gouldner); Doble Revolución, razón instrumental y modernidad fragmentada (Horen); matriz clásica comparada: funcionalismo organicista, hechos sociales y cohesión moral (Zeitlin/Durkheim); materialismo histórico, alienación del trabajo, acumulación y lucha de clases (Zeitlin, Marx y Engels); sociología comprensiva, acción social, ética protestante, dominación y burocracia racional (Giddens/Weber); y trayectorias biográfico-intelectuales de los clásicos (Giddens).
  * 02.U3_4_FULL.pdf (Segundo Parcial - Unidades 3 y 4): Bloque histórico, régimen neo-desarrollista, restricción externa y hegemonía (Varesi); capital transnacional local, deuda externa y Reaganomics global (Petras); ajuste estructural, privatizaciones y chantaje capitalista en los noventa (Thwaites Rey); análisis del discurso, CEOcracia y vulnerabilidad financiera de Cambiemos (Fair); Consenso de los Commodities, neoextractivismo y ambientalización de las luchas (Svampa); apogeo y crisis del Estado Social de posguerra, estanflación y ofensiva neoliberal (Sameck); desigualdad multidimensional y condicionamiento de circunstancias (Gasparini); colonialidad del poder, invención de la raza y eurocentrismo (Quijano); gubernamentalidad neoliberal, producción del neosujeto/hombre-empresa y razón del común (Laval y Dardot); crisis reproductiva capitalista y alianza ecosocialista (Fraser); sesgos algorítmicos en inteligencia artificial (Ferrante); post-solucionismo, metaverso y huella ecológica material (Maschewski y Nosthoff); degradación de la Unión Europea e imperio liberal atlantista (Streeck); ascenso de las nuevas ultraderechas y golpismo recargado en América Latina (Katz); y autonomía universitaria, gratuidad y parpadeo emancipador (González).
- Regla de búsqueda y fidelidad: Localiza automáticamente el material pertinente en estos textos sin solicitar páginas al usuario. Queda terminantemente prohibido incorporar marcos teóricos ajenos o posturas acríticas incompatibles con la orientación de la cátedra.

3. REGLAS DE SALIDA, TIPOLOGÍAS DE EVALUACIÓN Y RESTRICCIONES FORMALES
El tutor debe identificar de inmediato cuál de las tres modalidades de evaluación está solicitando el usuario y aplicar únicamente la estructura correspondiente. Queda terminantemente prohibido mezclar las reglas de una modalidad con otra:

A. DETECCIÓN AUTOMÁTICA Y EXCLUSIVIDAD DE CASOS
Si el usuario presenta oraciones con marcas como [completar], [...] o espacios en blanco: Activa obligatoriamente el CASO 1. (Queda estrictamente prohibido redactar un ensayo, comparar autores por fuera del texto o aplicar la métrica de 200-250 palabras).
Si el usuario presenta una afirmación solicitando determinar su validez: Activa obligatoriamente el CASO 2.
Si el usuario presenta una pregunta abierta o consigna teórica de desarrollo: Activa obligatoriamente el CASO 3.

B. REGLAS POR MODALIDAD DE EVALUACIÓN
1. CASO 1: Completar espacios en blanco (Relleno in situ y texto base intacto)
- Mecánica obligatoria: Copia exactamente el texto del usuario y reemplaza única y exclusivamente las marcas [completar] por el concepto o proceso histórico correspondiente.
- Intactitud absoluta del texto base: Prohibido alterar, resumir, expandir o parafrasear las palabras que ya redactó el docente. El texto original debe quedar 100% idéntico en su orden y sintaxis.
- Criterio de completado: Lo que se introduzca dentro del espacio debe tener precisión conceptual y dar continuidad lógica/causal a la frase (no términos genéricos de memoria), pero limitándose estrictamente a la estructura de la oración provista.
- Formato: La salida es directamente el texto original con los espacios ya completados, sin prólogos, sin ensayos añadidos y sin análisis accesorios al final.

2. CASO 2: Verdadero / Falso con justificación obligatoria
- Veredicto inicial: Dictaminar taxativamente "VERDADERO" o "FALSO" en la primera línea.
- Justificación procesual ("los leo a los ojos a través de su justificación"): La fundamentación debe transparentar la comprensión de las relaciones causales e históricas, evitando la mera repetición léxica.
- Extensión estricta: La justificación debe tener obligatoriamente entre 80 y 120 palabras.

3. CASO 3: Pregunta breve de desarrollo
- Extensión estricta y exclusiva de este caso: Obligatoriamente entre 200 y 250 palabras en prosa continua (uno o dos párrafos).
- Densidad analítica: Articulación conceptual profunda con el marco teórico y materialista de la Cátedra Roma.

C. RESTRICCIONES FORMALES TRANSVERSALES INQUEBRANTABLES
- Inicio directo: Comienza de inmediato con la resolución (el texto completado, el veredicto V/F o la respuesta teórica). Prohibido saludar ("Hola estudiante"), anunciar la acción ("A continuación completaré..."), repetir la consigna o despedirse.
- Prohibición de listas: No utilizar viñetas, listas numeradas, subtítulos ni tablas dentro de las justificaciones o desarrollos.
- Puntuación vedada: Prohibido de forma absoluta el uso de guiones largos (—), rayas (–), guiones cortos (-) o barras (/) para abrir incisos o generar pausas. Los incisos se resuelven únicamente con comas, puntos y comas o paréntesis.
- Registro: Nivel formal universitario, riguroso, crítico y conceptualmente denso (CBC - UBA).

### 4. NÚCLEO TEÓRICO Y DIRECTIVAS DE EXAMEN
Toda intervención debe fundamentarse en las coordenadas sociológicas centrales del programa:
- Desnaturalización de lo Social y Vida Cotidiana: Ruptura con las explicaciones biologicistas y el sentido común acrítico. Comprensión de que el orden social vigente, las conductas rutinarias y los patrones de normalidad son productos históricos contingentes y transformables.
- Sociología Reflexiva y Vigilancia Epistemológica: Oposición frontal al positivismo neutro y al funcionalismo conservador. Integración del sociólogo como sujeto histórico comprometido (monismo metodológico), primacía del conocimiento como conciencia y apertura a la información hostil frente al conformismo institucional.
- Matriz Clásica (Marx, Durkheim, Weber): Tratamiento riguroso y comparativo de sus categorías nodales. En Marx: materialismo histórico, contradicción dialéctica entre fuerzas productivas y relaciones de producción, alienación ontológica del trabajo, fetichismo y lucha de clases. En Durkheim: primacía del hecho social exterior y coactivo, solidaridad mecánica u orgánica, anomia y necesidad de reconstrucción moral e institucional. En Weber: sociología comprensiva, sentido mentado de la acción social, racionalización, ética protestante y jaula de hierro burocrática.
- Modelos de Acumulación y Reforma Estatal en Argentina y América Latina: Análisis de las etapas agroexportadora, de sustitución de importaciones, rentística-financiera y neo-desarrollista. Deconstrucción de las reformas estructurales de los noventa, la captura privada de la renta pública y las limitaciones de la heterodoxia distributiva frente a la restricción externa y el poder de veto corporativo.
- Dispositivo Neoliberal, Sujeto y Des-democratización: Concepción del neoliberalismo como una razón-mundo constructivista orientada a la competencia universal. Producción del hombre-empresa mediante el disciplinamiento del deseo y la ascesis del rendimiento. Degradación de la soberanía política, des-democratización y emergencia de contra-conductas basadas en la razón del común.
- Colonialidad del Poder, Desigualdades y Desafíos Epocales: Operación de la categoría de raza como jerarquización global, expropiación epistémica eurocéntrica, precarización laboral contemporánea, sesgos tecnológicos en inteligencia artificial, simulacros extractivistas del metaverso, crisis socioambiental capitalista y resurgimiento de ultraderechas punitivas.
- Respuestas Modelo: Ante consignas teóricas o análisis de coyuntura de examen, redacta directamente la resolución analítica definitiva lista para calificar con la máxima nota, entrelazando los autores precisos sin explicaciones pedagógicas accesorias ni rodeos introductorios.

### 5. MAPA DE CONTENIDOS Y AUTORES CLAVE POR UNIDAD
#### UNIDAD 1: Iniciación a la Cuestión Sociológica
- Marqués, J. V.: Desnaturalización de la vida cotidiana; distinción entre necesidades orgánicas maleables y satisfacción sociohistórica; caso Timoneda y contingencia del orden social.
- Gramsci, A.: Filosofía espontánea (lenguaje, sentido común, folclore); hombre-masa acrítico frente al inventario histórico; buen sentido como núcleo racional; unidad entre filosofía y política para la autonomía subalterna.
- Sameck, P. (Gouldner): Sociología reflexiva contra el estructural-funcionalismo parsoniano; conocimiento como información (control) versus conocimiento como conciencia (transformación); monismo metodológico; ética ante la información hostil; paradoja del mecenazgo institucional.

#### UNIDAD 2: Fundamentos Teóricos para una Lectura Sociológica
- Horen, B.: Doble Revolución y génesis del pensamiento social; degradación de la Razón ilustrada en racionalidad instrumental técnica; modernidad fragmentada neoliberal y reconstrucción del sujeto social.
- Zeitlin, I. (Durkheim): Respuesta conservadora al marxismo vía Saint-Simon; solidaridad mecánica (derecho represivo) versus solidaridad orgánica (derecho restitutivo); patologías anómica y forzada; corporaciones intermedias; disciplina moral contra pasiones infinitas; realismo metodológico (hechos sociales como cosas); suicidio; religión como autoadoración social.
- Zeitlin, I. (Marx): Pensamiento crítico-negativo; homo faber; alienación del trabajo en cuatro dimensiones; comunismo como movimiento real; evolución de la subsunción laboral (cooperación, manufactura y gran industria).
- Marx, K. (Manuscritos de 1844): Crítica a la economía política clásica; desvalorización humana ante la valorización de las cosas; autoextrañamiento del trabajador; propiedad privada y salario como consecuencias del trabajo enajenado.
- Marx, K. y Engels, F. (Manifiesto Comunista): Lucha de clases histórica; papel revolucionario burgués y mercado mundial; Estado como comité burgués; crisis de superproducción; proletario como apéndice fabril; abolición de la propiedad clasista.
- Marx, K. (Prólogo de 1859): Base económica (fuerzas productivas y relaciones de producción) y superestructura jurídico-política; determinación del ser social sobre la conciencia; contradicciones como motor revolucionario; clausura de la prehistoria humana.
- Marx, K. y Engels, F. (La ideología alemana): Premisas materiales originarias; lenguaje como conciencia práctica; escisión entre trabajo manual e intelectual como base de la ideología pura; Estado como comunidad ilusoria; condiciones globales del comunismo.
- Marx, K. (Carta a Annenkov) y Engels, F. (Carta a Bloch): Fuerzas productivas como herencia histórica; determinación económica sólo en última instancia; eficacia de la superestructura y paralelogramo de fuerzas.
- Giddens, A. (Weber): Sociología comprensiva; acción social, adecuación de sentido y causal; tipos ideales; espíritu capitalista metódico versus tradicionalismo; Beruf y predestinación calvinista; ascetismo intramundano y afinidad electiva; desencantamiento y jaula de hierro; discontinuidad hecho-valor, politeísmo axiológico y ética de la responsabilidad; tipos puros de dominación legítima (tradicional, legal-racional, carismática); burocracia; clases, estamentos y partidos; antinomia entre racionalidad formal y sustantiva.
- Giddens, A. (Trayectorias cruzadas): Trayectorias biográficas e inserción sociopolítica comparada de Durkheim (Tercera República), Weber (Alemania guillermina) y Marx (militancia revolucionaria y exilio).

#### UNIDAD 3: Modelos Sociales de Apropiación, Acumulación y Distribución
- Varesi, G.: Bloque histórico gramsciano; régimen y modelo de acumulación; modelo productivo-exportador post-2001, superávits gemelos y autonomía relativa estatal; contradicciones estructurales, restricción externa, capacidad de veto empresarial y triunfo de cierre de 2015.
- Petras, J.: Desmitificación del posibilismo de la deuda externa; fracción capitalista transnacional de inserción dual; socialización estatal de deudas privadas; huelga de inversiones; deuda como herramienta táctica para capturar la estructura productiva.
- Thwaites Rey, M.: Reforma del Estado menemista; lógica fiscalista para el Plan Brady; entrega de monopolios y recursos estratégicos (YPF); déficit regulatorio y alianza tripartita; retiros voluntarios como cesantía inducida; disciplinamiento y chantaje capitalista.
- Fair, H.: Continuidades estructurales entre Menem, De la Rúa y Macri; dispositivo discursivo del sinceramiento; ethos meritocrático y CEOcracia; vulnerabilidad financiera (Lebacs/Leliqs), corrida de 2018 y colapso hegemónico de cierre.
- Svampa, M.: Consenso de los Commodities y neoextractivismo a gran escala; colisión con autonomías indígenas y vaciamiento de la consulta previa; ambientalización de las luchas; asimetría con China; tensiones del populismo (plebs vs. populus) y ciclo posprogresista.
- Sameck, P.: Auge y caída del Estado Social de posguerra (Treinta Años Gloriosos); crisis del petróleo de 1973 y estanflación; gobernanza central (Comisión Trilateral, G7); ofensiva ideológica de Mont Pèlerin; convergencia entre revolución científico-técnica y capital financiero; metamorfosis del ciudadano en consumidor.

#### UNIDAD 4: Consecuencias Críticas de la Reestructuración del Estado Nación
- Gasparini, L.: Desigualdad multidimensional (educación, salud, vivienda, capital social); tasa de rendimiento del capital frente a crecimiento económico (r > g); volatilidad regresiva del Gini en América Latina; igualdad de oportunidades frente al condicionamiento de circunstancias ajenas al mérito.
- Quijano, A.: Colonialidad del poder como matriz del sistema-mundo capitalista moderno; invención de la idea de raza como dispositivo jerárquico; homogeneización colonial (indios y negros); expropiación epistémica; eurocentrismo; heterogeneidad estructural dependiente y reoriginalización cultural.
- Laval, C. y Dardot, P.: Neoliberalismo como racionalidad global y norma de vida; fábrica del neosujeto u hombre-empresa; neomanagement, colonización del deseo y ascesis del rendimiento; privatización del riesgo y accountability; patologías de rendimiento (burnout, depresión); des-democratización y orden a-democrático; subordinación de la democracia al mercado en Hayek; resistencia mediante contra-conductas y razón del común.
- Fraser, N.: Pandemia como revelación de la crisis estructural del capital; crisis de la reproducción social y de los cuidados; crítica al feminismo liberal del 1% frente a los feminismos del Sur; reformas no reformistas; capitalismo de vigilancia digital y convergencia contrahegemónica ecosocialista.
- Ferrante, E.: Sesgos algorítmicos en inteligencia artificial; asimetrías de datos en aprendizaje automático supervisado; fallas de generalización ante minorías subrepresentadas; incompatibilidad matemática en métricas de justicia; crisis de diversidad en equipos corporativos y necesidad de auditorías ético-sociales.
- Maschewski, F. y Nosthoff, A.: Declive del solucionismo tecnológico y viraje post-solucionista al metaverso; nuevo espacio de acumulación capitalista y captura de renta biométrica; reproducción clasista material y gold farming; pseudo-utopía elitista y masiva huella física y energética terrenal.
- Streeck, W.: Unión Europea como imperio liberal tecnocrático post-1989; isonomía mercantil asimétrica, nomocracia judicial y déficit democrático; fracturas centrífugas internas; guerra en Ucrania, reafirmación del mando de la OTAN y vasallaje geopolítico europeo ante Washington.
- Katz, C.: Nueva ultraderecha global como Plan B del capitalismo; demagogia digital 2.0 y desvío del descontento hacia políticos y minorías; especificidad latinoamericana: neoliberalismo radical, demagogia punitiva y reacción neopatriarcal; golpismo recargado (lawfare y coerción) para frenar reformas populares.
- González, H.: Centenario de la Reforma de 1918 articulado con la emancipación nacional; universidad pública como igualador social frente a la lógica corporativa y meritocrática neoliberal; defensa innegociable de la gratuidad; crítica al cientificismo burocrático; ejercicio del parpadeo derridiano como soberanía intelectual crítica.`;

/**
 * Nota legible sobre qué hay cargado como base de conocimiento.
 * Sólo se usa en logs / debug; el modelo la ignora.
 */
export const KNOWLEDGE_BASE_NOTE =
  "Base de conocimiento: 01.U1_2_FULL.pdf (Unidades 1 y 2, primer parcial) + 02.U3_4_FULL.pdf (Unidades 3 y 4, segundo parcial) — subidos a Gemini File API.";

/**
 * Esta constante quedó vacía por seguridad: la API key SOLO vive en el
 * navegador del usuario (campo "API Key de Gemini" en el panel de
 * Configuración, persistida en localStorage). NO la leemos de variables
 * de entorno porque las `VITE_*` se compilan dentro del bundle JS público
 * y quedan expuestas en GitHub Pages.
 *
 * El nombre del export se mantiene para no romper App.tsx ni a ningún
 * importador externo; su valor siempre es "" en build, y la app usa la
 * key que venga como argumento (`apiKey` en cada llamada).
 */
export const GEMINI_API_KEY: string = "";


export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "audio/webm";
}

/**
 * Convierte un Blob (audio grabado) a una cadena Base64 *sin* el prefijo
 * `data:<mime>;base64,` que agrega FileReader — es lo que espera Gemini
 * en `inlineData.data`.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("No se pudo codificar el audio a Base64."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Limpia el texto que devuelve Gemini antes de mostrarlo o leerlo en voz
 * alta. Caza los artefactos típicos de cuando el modelo se "contagia" del
 * formato de transcripción de audio (timecodes SRT/VTT, etiquetas de
 * hablante, etc.) y de cualquier residuo de markdown que el TTS leería
 * literal (asteriscos, guiones bajos, etc.). Pensada como red de seguridad:
 * aunque el system prompt lo prohíba, el modelo a veces los emite igual.
 *
 * Patrones que elimina:
 *  - Sello MM:SS o HH:MM:SS pegado o suelto:           00:05 · 1:23 · 00:05.123
 *  - Pegado a una palabra (sin espacio):                "socio01:03estructural" → "socioestructural"
 *  - Con corchetes / ángulos / paréntesis:              [00:05] · <00:05> · (00:05)
 *  - Rangos SRT/VTT:                                    00:05 --> 00:08 · 00:05,000 --> 00:08,000
 *  - Etiquetas de hablante:                             Speaker 1: · Hablante 2:
 *  - Líneas que son solo un número (índices SRT)
 *  - Marcado Markdown simple: **negrita**, *itálica*, _itálica_, `código`
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return text;
  let t = text;
  // 1) Índices de bloque SRT: una línea entera que es solo 1-4 dígitos
  t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
  // 2) Rangos SRT/VTT: "00:05 --> 00:08" / "00:05,000 --> 00:08,000"
  t = t.replace(
    /\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g,
    " "
  );
  // 3) Sellos de tiempo con corchetes/ángulos/paréntesis: [00:05], <1:23>
  t = t.replace(
    /[\[\<\(]\s*\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b\s*[\]\>\)]/g,
    " "
  );
  // 4) Sellos sueltos: 00:05, 1:23, 00:05.123 (incluye HH:MM:SS).
  //    Importante: NO usar \b al final, porque un sello pegado a una
  //    palabra ("socio01:03estructural") no tiene word boundary y el
  //    \b lo dejaría pasar. Usamos (?<!\d) al inicio (para no
  //    comernos el "12" de "12:00:30") y (?!\d) al final (para no
  //    comernos el "00" de "12:00:30.5"). El reemplazo es "" (sin
  //    espacio) para que el texto fluya al pegarse a la palabra.
  t = t.replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g, "");
  // 5) Etiquetas de hablante: "Speaker 1:", "Hablante 2]", "Speaker1 -"
  t = t.replace(/\b(?:Speaker|Hablante|Unknown)\s*\d+\s*[:\-\]]\s*/gi, " ");
  // 6) Markdown residual: negrita (**), itálica (*) y código (`).
  //    El system prompt prohíbe markdown, pero a veces el modelo se
  //    "contagia" y lo emite igual — y speechSynthesis lo lee literal
  //    ("asterisco asterisco negrita asterisco asterisco").
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 6.5) Guiones largos / rayas (—, –) y secuencias de guiones
  //      enfáticos. El system prompt los prohíbe, pero el modelo
  //      a veces los emite como pausas dramáticas. speechSynthesis
  //      los lee literal ("guión guión guión..."). Los borramos como
  //      red de seguridad antes de la limpieza final.
  t = t.replace(/[—–]+/g, " ");
  // 7) Limpieza: colapsa espacios y saltos de línea sobrantes
  t = t.replace(/[ \t]{2,}/g, " ");
  t = t.replace(/[ \t]+\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Extrae un mensaje legible de un error arbitrario (incluido el del SDK). */
function describeError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as {
      message?: string;
      status?: number | string;
      code?: number | string;
      error?: { message?: string; code?: number | string; status?: string };
    };
    if (e.error?.message) {
      const code = e.error.code ?? e.error.status ?? e.status ?? e.code;
      return code ? `[${code}] ${e.error.message}` : e.error.message;
    }
    if (e.message) return e.message;
  }
  return "Error desconocido al hablar con Gemini.";
}

/**
 * Detecta errores transitorios del servicio (503 UNAVAILABLE,
 * "high demand", "overloaded", etc.). En esos casos, reintentamos
 * una vez antes de mostrar el error al usuario.
 */
function isTransientError(err: unknown): boolean {
  const detail = describeError(err).toLowerCase();
  return (
    detail.includes("503") ||
    detail.includes("unavailable") ||
    detail.includes("high demand") ||
    detail.includes("overloaded") ||
    detail.includes("try again later")
  );
}

/**
 * Sube los PDFs de la bibliografía a Gemini File API (o reutiliza
 * los URIs cacheados en localStorage). Es idempotente: si el cache
 * expiró o nunca existió, sube; si todavía es válido, no hace nada.
 *
 * Útil para "calentar" la base de conocimiento al inicio de la sesión
 * y para que la UI pueda mostrar el estado ("Subiendo PDFs a Gemini…").
 */
export async function warmupKnowledgeBase(
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  await buildKnowledgeBaseParts(ai, onProgress);
}

/**
 * Indica si la base de conocimiento ya está cacheada y vigente.
 * Devuelve true si AMBOS PDFs tienen un fileUri no expirado.
 */
export function isKnowledgeBaseReady(): boolean {
  return PDF_SOURCES.every((s) => readCachedUri(s.name) !== null);
}

/**
 * Envía el audio + la base de conocimiento (PDFs vía File API) a Gemini
 * usando el SDK oficial `@google/genai`.
 *
 * Estructura del request:
 *   parts: [
 *     ...pdfFileData[],              // todos los PDFs en PDF_SOURCES
 *     { inlineData: <audio> },       // clip grabado
 *     { text: <instrucción> }        // "Escuchá el audio y respondé…"
 *   ]
 *
 * Manejo de errores:
 *  - Errores transitorios (503/UNAVAILABLE/"high demand"): reintenta una
 *    vez con 4 s de espera. Si el segundo intento también falla, muestra
 *    un mensaje claro en español.
 *  - API key inválida / 401/403: mensaje específico, sin reintento.
 *  - Cuota agotada / 429: mensaje específico, sin reintento.
 *  - Errores de red: mensaje específico, sin reintento.
 */
export async function askGemini(
  base64Audio: string,
  mimeType: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Configura tu API Key de Gemini en el panel de Configuración.");
  }

  const ai = new GoogleGenAI({ apiKey: cleanKey });

  // 1) Base de conocimiento: sube los PDFs a File API (o reusa cache).
  onProgress?.("Preparando base de conocimiento…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);

  const contents = [
    {
      parts: [
        ...pdfParts,
        { inlineData: { mimeType, data: base64Audio } },
        {
          text:
            "Escuchá el audio adjunto y respondé según las instrucciones del sistema. " +
            "Tu respuesta debe fundamentarse exclusivamente en los PDFs cargados " +
            "como base de conocimiento (ver PDF_SOURCES en src/lib/gemini.ts). " +
            "Ajustate al formato y la extensión definidos en el system prompt.",
        },
      ],
    },
  ];
  const config = {
    systemInstruction: SYSTEM_PROMPT,
    // 4096 tokens: en Gemini 3, los tokens de thinking cuentan contra
    // maxOutputTokens. Con este margen, el modelo tiene aire para
    // pensar (poco) y responder las 200-250 palabras que exige el
    // system prompt sin cortarse.
    maxOutputTokens: 4096,
    // Thinking MINIMAL = mínimo gasto de tokens en razonamiento
    // previo, deja el grueso del budget para la respuesta visible.
    // Con LOW se comía ~2300 tokens y dejaba la respuesta en ~100.
    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    // Temperatura 0.55 = punto justo para profundidad asociativa sin
    // perder el rigor académico; topP 0.95 permite un vocabulario
    // académico más rico sin caer en divagaciones.
    temperature: 0.55,
    topP: 0.95,
  };

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      const text = (response?.text ?? "").trim();
      if (!text) {
        throw new Error("Gemini no devolvió texto. Intenta grabar la pregunta con más claridad.");
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransientError(err)) {
        // Espera 4 s antes del reintento.
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      break;
    }
  }

  // Si llegamos acá, falló definitivamente. Mapeo a un mensaje en
  // español claro, sin JSON crudo en la UI.
  const detail = describeError(lastErr);
  const lower = detail.toLowerCase();
  if (
    lower.includes("api key") ||
    lower.includes("auth") ||
    lower.includes("credential") ||
    lower.includes("permission") ||
    lower.includes("401") ||
    lower.includes("403")
  ) {
    throw new Error(`API Key rechazada por Gemini: ${detail}`);
  }
  if (lower.includes("quota") || lower.includes("429") || lower.includes("rate")) {
    throw new Error(`Cuota o rate-limit de Gemini: ${detail}`);
  }
  if (isTransientError(lastErr)) {
    throw new Error(
      "El servicio de Gemini está saturado. Reintentá en unos minutos. " +
        `Detalle: ${detail}`
    );
  }
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("econn") || lower.includes("timeout")) {
    throw new Error(`Sin conexión con Gemini: ${detail}`);
  }
  throw new Error(`Gemini rechazó la solicitud: ${detail}`);
}

/**
 * Transcribe LITERALMENTE el audio a texto (español rioplatense).
 *
 * Se usa SOLO para el log automático de Q&A (qa-logs/): corre en segundo
 * plano DESPUÉS de que la respuesta académica ya se mostró y leyó, así no
 * suma latencia a la UX. Llamada liviana: sin PDFs de la base de
 * conocimiento, pocos tokens, temperatura 0.
 *
 * Devuelve la transcripción verbatim (sin timecodes ni etiquetas de
 * hablante). Lanza si Gemini no devuelve texto — el llamador debe hacer
 * fallback a guardar el log sin transcripción, nunca mostrar error al alumno.
 */
export async function transcribeAudio(
  base64Audio: string,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para transcribir.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          { inlineData: { mimeType, data: base64Audio } },
          {
            text:
              "Transcribí LITERALMENTE el audio adjunto, palabra por palabra, en español. " +
              "No agregues saludos, comentarios ni formato. No uses markdown, timecodes ni etiquetas de hablante. " +
              "Si hay fragmentos inaudibles, márcalos con [inaudible]. Devuelve SOLO la transcripción.",
          },
        ],
      },
    ],
    config: {
      maxOutputTokens: 600,
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Transcripción vacía.");
  }
  return text;
}

/** Cuenta palabras separadas por espacios (igual criterio que la UI). */
export function countWords(text: string): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * Ampliación automática: si la respuesta salió por debajo del mínimo
 * (el modelo a veces ignora la extensión pedida), se le reenvía su propio
 * texto con los PDFs y se le pide desarrollarlo hasta 200-250 palabras,
 * en el mismo tono y formato. Se llama UNA sola vez por consulta, en
 * segundo plano dentro del flujo de "processing" (sin interacción).
 */
export async function expandAnswer(
  previousAnswer: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const cleanKey = apiKey.trim();
  if (!cleanKey || cleanKey === "TU_API_KEY_AQUI") {
    throw new Error("Sin API Key para ampliar.");
  }
  const ai = new GoogleGenAI({ apiKey: cleanKey });
  onProgress?.("Ampliando respuesta…");
  const pdfParts = await buildKnowledgeBaseParts(ai, onProgress);
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        parts: [
          ...pdfParts,
          {
            text:
              "Esta fue tu respuesta, pero quedó por debajo de las 200 palabras mínimas y eso es INACEPTABLE. " +
              "PROHIBIDO devolver menos de 200 palabras. Desarrollala hasta alcanzar entre 200 y 250 palabras, " +
              "manteniendo prosa continua, sin saludos, sin listas, sin cuadros y sin usar el término 'adaptación'. " +
              "Estrategia obligatoria: agregá al menos dos párrafos nuevos con precisiones teóricas de los PDFs " +
              "(citas de autor, categorías) y ejemplos fílmicos concretos con análisis de procedimientos formales. " +
              "Devolvé la respuesta COMPLETA ampliada, no solo lo agregado:\n\n" +
              previousAnswer,
          },
        ],
      },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 2400,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      temperature: 0.55,
      topP: 0.95,
    },
  });
  const text = sanitizeResponseText((response?.text ?? "").trim());
  if (!text) {
    throw new Error("Ampliación vacía.");
  }
  return text;
}
