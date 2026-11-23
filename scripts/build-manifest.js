'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const composeDir = path.join(rootDir, '.homeycompose');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadFlowFolder(subFolder) {
  const dir = path.join(composeDir, 'flow', subFolder);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return files.map(file => {
    const id = path.basename(file, '.json');
    const content = readJson(path.join(dir, file));
    return { id, ...content };
  });
}

const baseManifest = readJson(path.join(composeDir, 'app.json'));
baseManifest.flow = {
  triggers: loadFlowFolder('triggers'),
  conditions: loadFlowFolder('conditions'),
  actions: loadFlowFolder('actions')
};
const outputPath = path.join(rootDir, 'app.json');
fs.writeFileSync(outputPath, JSON.stringify(baseManifest, null, 2) + '\n', 'utf8');
console.log(`Built app.json with ${baseManifest.flow.triggers.length} triggers, ${baseManifest.flow.conditions.length} conditions, and ${baseManifest.flow.actions.length} actions.`);
