// =====================================================================
// agrometeo-cacg / extract.js
// ---------------------------------------------------------------------
// Descarga el PDF público de CACG, extrae texto con pdf-parse y lo
// estructura en JSON con invernada (rangos por kg) + vientres + gordo.
// El JSON se escribe en ./cacg.json y se commitea al repo.
// =====================================================================

import fs from 'fs/promises';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const URL_PDF = 'https://cacg.org.ar/precios';

// ---------- Helpers ----------
const parseN = (s) => {
  if (s == null) return 0;
  return parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
};
const hoyISO = () => new Date().toISOString().slice(0, 10);

// ---------- Main ----------
async function main() {
  console.log(`📥 Descargando PDF desde ${URL_PDF}...`);
  const res = await fetch(URL_PDF, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/pdf,*/*',
      'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bajando PDF`);

  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`   PDF bajado: ${buf.length.toLocaleString()} bytes`);

  console.log('🔍 Extrayendo texto del PDF...');
  const data = await pdfParse(buf);
  const texto = data.text;
  console.log(`   Texto extraído: ${texto.length.toLocaleString()} caracteres`);

  // Guardar dump de texto plano para debug (se commitea solo la primera vez por si necesitamos ajustar)
  await fs.writeFile('./cacg.debug.txt', texto, 'utf8');

  console.log('🧱 Parseando...');
  const out = parsear(texto);
  out.fecha_extraccion = hoyISO();
  out.url_fuente = URL_PDF;

  await fs.writeFile('./cacg.json', JSON.stringify(out, null, 2), 'utf8');
  console.log(`✅ Escrito cacg.json con:`);
  console.log(`   invernada machos:  ${out.invernada.machos.length} filas`);
  console.log(`   invernada hembras: ${out.invernada.hembras.length} filas`);
  console.log(`   invernada mixtos:  ${out.invernada.mixtos.length} filas`);
  console.log(`   vientres:          ${out.vientres.length} filas`);
  console.log(`   gordo:             ${out.gordo.length} filas`);
  console.log(`   fecha_publicacion: ${out.fecha_publicacion}`);
}

// ---------- Parser ----------
// El texto extraído por pdf-parse viene con saltos de línea decentes,
// pero los datos a veces vienen pegados. Estrategia: tokenizar por whitespace,
// detectar runs de >=4 números y armar la fila mirando atrás para conseguir
// la etiqueta (peso o categoría).
function parsear(texto) {
  // Normalizar
  const t = texto.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // Fechas
  const fechaPubM = t.match(/(\d{2}\/\d{2}\/\d{2,4})\s+PRECIOS/i)
                 || t.match(/(\d{2}\/\d{2}\/\d{2,4})/);
  const periodoM = t.match(/al\s+(\d{2}\/\d{2}\/\d{2,4})/i);

  const tokens = t.split(' ').filter(Boolean);
  const isNum = (s) => /^[\d.]+$/.test(s) && !/^\.+$/.test(s);

  // Stopwords que NO pueden ser parte de un label
  const stopWords = /^(Terneros|Terneras|Novillitos|Vaquillonas|Vacas|Toros|Gordo|Categoría|Categoria|Total|Peso|Por|Al|Promedio|Máximo|Maximo|Mínimo|Minimo|Cabezas|Invernada|Cría|Cria|Condición|Condicion|Kgs|Kg|Macho|Hembra|Macho\/Hembra|Bulto|kilo|Fuente|ENTRE|SURCOS|y|CORRALES|CÁMARA|CAMARA|ARGENTINA|DE|CONSIGNATARIOS|GANADO|Remates|Feria|Internet|y\/o|Televisión|Television|del|al|N°|Nro\.|PRECIOS)$/i;

  // Headers que cambian de sección
  const sectionHeaders = {
    'Terneros':    'machos_terneros',
    'Novillitos':  'machos_novillitos',
    'Terneras':    'hembras_terneras',
    'Vaquillonas': 'hembras_vaquillonas',
    'Gordo':       'gordo',
  };

  // Marcadores que detectamos en orden
  const idxTerneros    = tokens.findIndex(x => x === 'Terneros');
  const idxTerneras    = tokens.findIndex((x, i) => x === 'Terneras' && i > idxTerneros);
  const idxMixtos      = tokens.findIndex((x, i) =>
    (x === 'Terneras/' || x === 'Terneras/Terneros') && i > (idxTerneras > 0 ? idxTerneras : 0)
  );
  const idxGordo       = tokens.findIndex(x => x === 'Gordo');

  // Recolección de filas
  const filas7 = []; // invernada: label + 7 números
  const filas4 = []; // vientres y gordo: label + 4 números

  let i = 0;
  while (i < tokens.length) {
    if (!isNum(tokens[i])) { i++; continue; }
    // Run de números
    let j = i;
    const nums = [];
    while (j < tokens.length && isNum(tokens[j]) && nums.length < 10) {
      nums.push(parseN(tokens[j]));
      j++;
    }
    if (nums.length >= 4) {
      // Mirar atrás hasta 5 tokens para armar label
      let labelStart = i;
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        if (isNum(tokens[k])) break;
        if (stopWords.test(tokens[k])) break;
        labelStart = k;
      }
      const label = tokens.slice(labelStart, i).join(' ').trim();
      if (label && label.length >= 2) {
        if (nums.length >= 7) {
          filas7.push({ label, nums: nums.slice(0, 7), start: i });
        } else {
          filas4.push({ label, nums: nums.slice(0, 4), start: i });
        }
      }
    }
    i = j;
  }

  // Clasificar
  const result = {
    source: 'cacg',
    fecha_publicacion: fechaPubM ? fechaPubM[1] : null,
    periodo_hasta: periodoM ? periodoM[1] : null,
    invernada: { machos: [], hembras: [], mixtos: [] },
    vientres: [],
    gordo: [],
  };

  const limMachos  = idxTerneras > 0 ? idxTerneras : Infinity;
  const limHembras = idxMixtos   > 0 ? idxMixtos   : (idxGordo > 0 ? idxGordo : Infinity);
  const limMixtos  = idxGordo    > 0 ? idxGordo    : Infinity;

  for (const f of filas7) {
    const item = {
      peso: f.label,
      cabezas: f.nums[0], prom_kilo: f.nums[1], max_kilo: f.nums[2], min_kilo: f.nums[3],
      prom_bulto: f.nums[4], max_bulto: f.nums[5], min_bulto: f.nums[6],
    };
    if (f.start < limMachos)       result.invernada.machos.push(item);
    else if (f.start < limHembras) result.invernada.hembras.push(item);
    else if (f.start < limMixtos)  result.invernada.mixtos.push(item);
  }

  for (const f of filas4) {
    if (idxGordo > 0 && f.start >= idxGordo) {
      result.gordo.push({
        cat: f.label,
        cabezas: f.nums[0],
        prom_kilo: f.nums[1],
        max_kilo: f.nums[2],
        min_kilo: f.nums[3],
      });
    } else if (f.start >= limMixtos && (idxGordo < 0 || f.start < idxGordo)) {
      result.vientres.push({
        cat: f.label,
        cabezas: f.nums[0],
        prom_bulto: f.nums[1],
        max_bulto: f.nums[2],
        min_bulto: f.nums[3],
      });
    }
  }

  return result;
}

// ---------- Run ----------
main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
