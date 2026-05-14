// =====================================================================
// agrometeo-cacg / extract.js (v2)
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
  const str = String(s).trim();
  // Soporta "3.136,71" (decimal con coma + miles con punto) y "1.150.000" (solo miles)
  if (str.includes(',')) {
    return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
  }
  return parseFloat(str.replace(/\./g, '')) || 0;
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

  // Guardar dump de texto plano para debug
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
  console.log(`   periodo_hasta:     ${out.periodo_hasta}`);
}

// ---------- Parser ----------
function parsear(texto) {
  const lineasRaw = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const fechaPubM = texto.match(/(\d{2}\/\d{2}\/\d{2,4})\s/);
  const periodoM = texto.match(/al\s+(\d{2}\/\d{2}\/\d{2,4})/);

  function extraerNumeros(s) {
    const tokens = s.split(/\s+/).filter(Boolean);
    return tokens
      .filter(t => /^[\d.]+(,\d+)?$/.test(t))
      .map(t => ({ tok: t, val: parseN(t) }));
  }
  function esSoloNumeros(s) {
    const tokens = s.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(t => /^[\d.]+(,\d+)?$/.test(t));
  }
  function extraerPeso(s) {
    const m = s.match(/^([+-]\s*(?:de\s+)?\d+|\d+\s*a\s*\d+|-\s*\d+|-\d+)\s*(.*)$/);
    if (!m) return null;
    return { peso: m[1].replace(/\s+/g, ' ').trim(), resto: m[2] };
  }

  const result = {
    source: 'cacg',
    fecha_publicacion: fechaPubM ? fechaPubM[1] : null,
    periodo_hasta: periodoM ? periodoM[1] : null,
    invernada: { machos: [], hembras: [], mixtos: [] },
    vientres: [],
    gordo: [],
  };

  // FASE 1: localizar rangos de línea de cada sección
  let lineMachosIni = -1, lineHembrasIni = -1, lineMixtosIni = -1;
  let lineVientresIni = -1, lineGordoIni = -1;

  for (let i = 0; i < lineasRaw.length; i++) {
    const l = lineasRaw[i];
    if (lineMachosIni < 0 && /^Terneros$/i.test(l)) lineMachosIni = i + 1;
    else if (lineMachosIni >= 0 && lineHembrasIni < 0 && /^Terneras$/i.test(l)) lineHembrasIni = i + 1;
    else if (lineHembrasIni >= 0 && lineMixtosIni < 0 && (/^Terneras\/$/i.test(l) || /^Terneras\/Terneros$/i.test(l))) lineMixtosIni = i + 1;
    else if (lineMixtosIni >= 0 && lineVientresIni < 0 && /^Total Machos \/ Hembras/i.test(l)) lineVientresIni = i + 1;
    else if (lineGordoIni < 0 && /^Gordo$/i.test(l)) lineGordoIni = i + 1;
  }

  // FASE 2: parser de INVERNADA
  function parsearInvernada(desde, hasta, key) {
    let i = desde;
    while (i < hasta) {
      const linea = lineasRaw[i];
      if (/^(Novillitos|Novillitos\/|Vaquillonas|Total)/i.test(linea)) { i++; continue; }
      const ext = extraerPeso(linea);
      if (ext) {
        let nums = extraerNumeros(ext.resto);
        let k = i + 1;
        while (nums.length < 7 && k < hasta) {
          const sig = lineasRaw[k];
          if (esSoloNumeros(sig)) {
            nums = nums.concat(extraerNumeros(sig));
            k++;
          } else break;
        }
        if (nums.length >= 7) {
          result.invernada[key].push({
            peso: ext.peso,
            cabezas:    nums[0].val,
            prom_kilo:  nums[1].val,
            max_kilo:   nums[2].val,
            min_kilo:   nums[3].val,
            prom_bulto: nums[4].val,
            max_bulto:  nums[5].val,
            min_bulto:  nums[6].val,
          });
          i = k;
          continue;
        }
      }
      i++;
    }
  }

  if (lineMachosIni >= 0)  parsearInvernada(lineMachosIni,  lineHembrasIni  > 0 ? lineHembrasIni  : lineasRaw.length, 'machos');
  if (lineHembrasIni >= 0) parsearInvernada(lineHembrasIni, lineMixtosIni   > 0 ? lineMixtosIni   : lineasRaw.length, 'hembras');
  if (lineMixtosIni >= 0)  parsearInvernada(lineMixtosIni,  lineVientresIni > 0 ? lineVientresIni : lineasRaw.length, 'mixtos');

  // FASE 3: parser de VIENTRES
  if (lineVientresIni >= 0) {
    const finVientres = lineGordoIni > 0 ? lineGordoIni : lineasRaw.length;
    let bufferCat = [];
    let grupoActual = '';

    for (let i = lineVientresIni; i < finVientres; i++) {
      const l = lineasRaw[i];

      if (/^Vaquillonas$/i.test(l)) { grupoActual = 'Vaquillonas'; bufferCat = []; continue; }
      if (/^Vacas$/i.test(l))       { grupoActual = 'Vacas';       bufferCat = []; continue; }
      if (/^(Categoría|Peso|Condición|Cabezas|Promedio|Máximo|Mínimo|Al bulto|Por kilo|Total)/i.test(l)) {
        bufferCat = [];
        continue;
      }

      const nums = extraerNumeros(l);
      if (nums.length === 0) {
        bufferCat.push(l);
        continue;
      }

      let allNums = nums.slice();
      let k = i + 1;
      while (allNums.length < 4 && k < finVientres) {
        const sig = lineasRaw[k];
        if (esSoloNumeros(sig)) {
          allNums = allNums.concat(extraerNumeros(sig));
          k++;
        } else break;
      }
      if (allNums.length >= 4) {
        const catFull = (grupoActual ? grupoActual + ' ' : '') + bufferCat.join(' ');
        result.vientres.push({
          cat: catFull.trim().replace(/\s+/g, ' '),
          cabezas:    allNums[0].val,
          prom_bulto: allNums[1].val,
          max_bulto:  allNums[2].val,
          min_bulto:  allNums[3].val,
        });
        bufferCat = [];
        i = k - 1;
      }
    }
  }

  // FASE 4: parser de GORDO
  if (lineGordoIni >= 0) {
    let bufferCat = [];
    for (let i = lineGordoIni; i < lineasRaw.length; i++) {
      const l = lineasRaw[i];
      if (/^(Categoría|Cabezas|Promedio|Máximo|Mínimo|Por kilo|Al bulto|Total|Fuente)/i.test(l)) {
        bufferCat = [];
        continue;
      }
      const nums = extraerNumeros(l);
      if (nums.length === 0) {
        bufferCat.push(l);
        continue;
      }
      let allNums = nums.slice();
      let k = i + 1;
      while (allNums.length < 4 && k < lineasRaw.length) {
        const sig = lineasRaw[k];
        if (esSoloNumeros(sig)) {
          allNums = allNums.concat(extraerNumeros(sig));
          k++;
        } else break;
      }
      if (allNums.length >= 4) {
        result.gordo.push({
          cat: bufferCat.join(' ').trim().replace(/\s+/g, ' '),
          cabezas:   allNums[0].val,
          prom_kilo: allNums[1].val,
          max_kilo:  allNums[2].val,
          min_kilo:  allNums[3].val,
        });
        bufferCat = [];
        i = k - 1;
      }
    }
  }

  return result;
}

// ---------- Run ----------
main().catch((e) => {
  console.error('❌ Error:', e);
  process.exit(1);
});
