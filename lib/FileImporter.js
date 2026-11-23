'use strict';

const XLSX = require('xlsx');
const Papa = require('papaparse');

class FileImporter {
  static isValidBackupQuiz(quiz) {
    return Boolean(
      quiz && typeof quiz === 'object' && !Array.isArray(quiz) && typeof quiz.title === 'string' &&
      Array.isArray(quiz.questions) && quiz.questions.every(question =>
        question && typeof question === 'object' && !Array.isArray(question) &&
        typeof question.question === 'string' && Array.isArray(question.options) &&
        question.options.length === 4 && question.options.every(option => typeof option === 'string') &&
        Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex <= 3 &&
        (question.timeLimit == null || (typeof question.timeLimit === 'number' && Number.isFinite(question.timeLimit))) &&
        (question.points == null || (typeof question.points === 'number' && Number.isFinite(question.points)))
      )
    );
  }

  /**
   * Parses an uploaded buffer or string into a normalized Quiz object
   * @param {Buffer} buffer
   * @param {string} originalName
   * @param {string} customQuizTitle
   */
  static parseQuizFile(buffer, originalName = 'import.json', customQuizTitle = '') {
    const ext = (originalName.split('.').pop() || '').toLowerCase();
    const baseName = customQuizTitle.trim() || originalName.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ');

    if (ext === 'json') {
      const raw = JSON.parse(buffer.toString('utf8'));
      return FileImporter.normalizeJsonQuiz(raw, baseName);
    }

    if (ext === 'csv') {
      const csvText = buffer.toString('utf8');
      const parsed = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: h => h.trim().toLowerCase()
      });
      if (parsed.errors && parsed.errors.length > 0 && (!parsed.data || parsed.data.length === 0)) {
        throw new Error(`CSV parse fout: ${parsed.errors[0].message}`);
      }
      const questions = FileImporter.rowsToQuestions(parsed.data);
      return {
        id: `quiz_${Date.now()}`,
        title: baseName || 'Geïmporteerde CSV Quiz',
        description: `Geïmporteerd uit ${originalName} (${questions.length} vragen)`,
        questions
      };
    }

    if (ext === 'xlsx' || ext === 'xls') {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        throw new Error('Excel-bestand bevat geen werkbladen.');
      }
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      const normalizedRows = rawRows.map(row => {
        const lowerRow = {};
        for (const [k, v] of Object.entries(row)) {
          lowerRow[String(k).trim().toLowerCase()] = v;
        }
        return lowerRow;
      });
      const questions = FileImporter.rowsToQuestions(normalizedRows);
      return {
        id: `quiz_${Date.now()}`,
        title: baseName || firstSheetName || 'Geïmporteerde Excel Quiz',
        description: `Geïmporteerd uit ${originalName} (${questions.length} vragen)`,
        questions
      };
    }

    throw new Error(`Niet-ondersteund bestandsformaat (.${ext}). Gebruik .xlsx, .csv of .json.`);
  }

  static normalizeJsonQuiz(raw, fallbackTitle) {
    if (Array.isArray(raw)) {
      if (raw.length === 0) throw new Error('Geen vragen gevonden in het bestand.');
      // Array of questions or rows
      const questions = raw[0] && Array.isArray(raw[0].options)
        ? raw.map((q, i) => FileImporter.normalizeQuestionObj(q, i))
        : FileImporter.rowsToQuestions(raw);
      return {
        id: `quiz_${Date.now()}`,
        title: fallbackTitle || 'Geïmporteerde JSON Quiz',
        description: `Geïmporteerde quiz met ${questions.length} vragen`,
        questions
      };
    }

    if (raw && Array.isArray(raw.questions)) {
      if (raw.questions.length === 0) throw new Error('Geen vragen gevonden in het bestand.');
      const questions = raw.questions.map((q, i) => FileImporter.normalizeQuestionObj(q, i));
      return {
        id: raw.id || `quiz_${Date.now()}`,
        title: raw.title || raw.name || fallbackTitle || 'Geïmporteerde JSON Quiz',
        description: raw.description || `Quiz met ${questions.length} vragen`,
        questions
      };
    }

    throw new Error('Ongeldige JSON-structuur: verwacht een object met een "questions" array.');
  }

  static normalizeQuestionObj(q, idx) {
    const text = String(q.question || q.text || q.vraag || `Vraag ${idx + 1}`).trim();
    const rawOptions = Array.isArray(q.options || q.antwoorden)
      ? (q.options || q.antwoorden)
      : [q.optie_1 || q.option1, q.optie_2 || q.option2, q.optie_3 || q.option3, q.optie_4 || q.option4];

    const options = [0, 1, 2, 3].map(i => String(rawOptions[i] ?? `Optie ${i + 1}`).trim());

    let correctIndex = Number(q.correctIndex ?? q.correct ?? q.juist_antwoord ?? 0);
    // If 1-based (1..4) in import when not explicitly 0-based
    if (q.juist_antwoord !== undefined && correctIndex >= 1 && correctIndex <= 4) {
      correctIndex = correctIndex - 1;
    }
    if (isNaN(correctIndex) || correctIndex < 0 || correctIndex > 3) {
      correctIndex = 0;
    }

    const timeLimit = Math.min(90, Math.max(5, Number(q.timeLimit || q.tijdslimiet || 20)));
    const points = Math.max(100, Number(q.points || q.punten || 1000));

    return {
      id: q.id || `q_${Date.now()}_${idx}`,
      question: text,
      options,
      correctIndex,
      timeLimit,
      points
    };
  }

  static rowsToQuestions(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('Geen vragen gevonden in het bestand.');
    }

    const questions = [];
    rows.forEach((row, idx) => {
      const qText = String(
        row.vraag || row.question || row.vraagtekst || row.text || ''
      ).trim();
      if (!qText) return;

      const opt1 = String(row.optie_1 ?? row.optie1 ?? row.option_1 ?? row.option_a ?? row.a ?? 'Optie A').trim();
      const opt2 = String(row.optie_2 ?? row.optie2 ?? row.option_2 ?? row.option_b ?? row.b ?? 'Optie B').trim();
      const opt3 = String(row.optie_3 ?? row.optie3 ?? row.option_3 ?? row.option_c ?? row.c ?? 'Optie C').trim();
      const opt4 = String(row.optie_4 ?? row.optie4 ?? row.option_4 ?? row.option_d ?? row.d ?? 'Optie D').trim();
      const options = [opt1, opt2, opt3, opt4];

      let rawCorrect = String(
        row.juist_antwoord ?? row.correct_answer ?? row.correct ?? row.juist ?? '1'
      ).trim().toUpperCase();

      let correctIndex = 0;
      if (['A', '1', 'OPTIE 1', 'OPTIE_1'].includes(rawCorrect)) correctIndex = 0;
      else if (['B', '2', 'OPTIE 2', 'OPTIE_2'].includes(rawCorrect)) correctIndex = 1;
      else if (['C', '3', 'OPTIE 3', 'OPTIE_3'].includes(rawCorrect)) correctIndex = 2;
      else if (['D', '4', 'OPTIE 4', 'OPTIE_4'].includes(rawCorrect)) correctIndex = 3;
      else {
        const matchIdx = options.findIndex(o => o.toUpperCase() === rawCorrect);
        if (matchIdx !== -1) correctIndex = matchIdx;
      }

      const timeLimit = Math.min(90, Math.max(5, Number(row.tijdslimiet || row.time_limit || row.time || 20)));
      const points = Math.max(100, Number(row.punten || row.points || 1000));

      questions.push({
        id: `q_${Date.now()}_${idx}`,
        question: qText,
        options,
        correctIndex,
        timeLimit,
        points
      });
    });

    if (questions.length === 0) {
      throw new Error('Kon geen geldige vragen herkennen. Controleer de kolomnamen (vraag, optie_1 t/m optie_4, juist_antwoord).');
    }

    return questions;
  }

  /**
   * Generates sample rows for downloadable examples (.xlsx, .csv, .json)
   */
  static getSampleRows() {
    return [
      {
        vraag: 'Welk bedrijf uit Enschede ontwikkelt het smart home platform Homey?',
        optie_1: 'Athom',
        optie_2: 'Signify',
        optie_3: 'Nabu Casa',
        optie_4: 'Trust Smart Home',
        juist_antwoord: 1,
        tijdslimiet: 20,
        punten: 1000
      },
      {
        vraag: 'Welk draadloos mesh-protocol werkt op 2.4 GHz en vormt de basis voor Matter-over-Thread?',
        optie_1: 'Z-Wave Long Range',
        optie_2: 'Thread (IEEE 802.15.4)',
        optie_3: 'Kaku 433 MHz',
        optie_4: 'Infrared Direct',
        juist_antwoord: 2,
        tijdslimiet: 20,
        punten: 1000
      },
      {
        vraag: 'Hoeveel punten krijg je in Party Quiz als je binnen de eerste seconde het juiste antwoord indrukt?',
        optie_1: '500 punten',
        optie_2: '750 punten',
        optie_3: '1000 punten',
        optie_4: '2000 punten',
        juist_antwoord: 3,
        tijdslimiet: 20,
        punten: 1000
      },
      {
        vraag: 'Welke stad is de hoofdstad van Nederland?',
        optie_1: 'Rotterdam',
        optie_2: 'Den Haag',
        optie_3: 'Utrecht',
        optie_4: 'Amsterdam',
        juist_antwoord: 4,
        tijdslimiet: 20,
        punten: 1000
      }
    ];
  }

  static generateSampleJson() {
    const rows = FileImporter.getSampleRows();
    const quiz = {
      title: 'Voorbeeld Homey Smart Home Quiz',
      description: 'Voorbeeldquiz voor import in Party Quiz',
      questions: FileImporter.rowsToQuestions(rows)
    };
    return JSON.stringify(quiz, null, 2);
  }

  static generateSampleCsv() {
    const rows = FileImporter.getSampleRows();
    return Papa.unparse(rows);
  }

  static generateSampleXlsxBuffer() {
    const rows = FileImporter.getSampleRows();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'QuizVragen');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }
}

module.exports = FileImporter;
