const fs = require('fs');
const path = require('path');

// Load existing knowledge base
const existingKnowledge = JSON.parse(fs.readFileSync('knowledge.json', 'utf-8'));
const newIntents = JSON.parse(fs.readFileSync('.firecrawl/new_intents.json', 'utf-8'));

// Get existing tags to avoid duplicates
const existingTags = new Set(existingKnowledge.map(intent => intent.tag));

console.log(`Existing intents: ${existingKnowledge.length}`);
console.log(`New intents to add: ${newIntents.length}`);

// Filter new intents (only add if tag doesn't already exist)
const intentsToAdd = newIntents.filter(intent => {
  if (existingTags.has(intent.tag)) {
    console.log(`  - Skipping ${intent.tag} (already exists)`);
    return false;
  }
  return true;
});

console.log(`Intents to actually add: ${intentsToAdd.length}`);

// Merge
const mergedKnowledge = [...existingKnowledge, ...intentsToAdd];

// Save merged knowledge base
fs.writeFileSync('knowledge.json', JSON.stringify(mergedKnowledge, null, 2), 'utf-8');

console.log(`\nMerge complete!`);
console.log(`Total intents in updated knowledge base: ${mergedKnowledge.length}`);
console.log(`\nNew intents added:`);
intentsToAdd.forEach(intent => {
  console.log(`  + ${intent.tag} (${intent.patterns.length} patterns)`);
});
