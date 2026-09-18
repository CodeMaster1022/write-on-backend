import { connectDb, disconnectDb } from "../config/db.js";
import { WordBankEntry } from "../models/WordBankEntry.js";
import { RewardItem } from "../models/RewardItem.js";

const words = [
  // Articles — tiny list on purpose; this is the whole set.
  { word: "the", partOfSpeech: "article", meaning: "points to one we already know", example: "The dog barked.", tier: 1 },
  { word: "a", partOfSpeech: "article", meaning: "points to any one of them", example: "A dog barked.", tier: 1 },
  { word: "an", partOfSpeech: "article", meaning: "use before a vowel sound", example: "An owl hooted.", tier: 1 },

  // Nouns
  { word: "octopus", partOfSpeech: "noun", meaning: "a sea animal with eight arms", example: "The octopus hid in the rocks.", tier: 1 },
  { word: "teacher", partOfSpeech: "noun", meaning: "a person who helps you learn", example: "My teacher read us a story.", tier: 1 },
  { word: "storm", partOfSpeech: "noun", meaning: "wild, windy weather", example: "The storm shook the windows.", tier: 2 },
  { word: "library", partOfSpeech: "noun", meaning: "a place full of books", example: "We walked to the library.", tier: 2 },
  { word: "adventure", partOfSpeech: "noun", meaning: "an exciting journey", example: "Her adventure began at dawn.", tier: 3 },
  { word: "invention", partOfSpeech: "noun", meaning: "something new that someone makes", example: "His invention could fly.", tier: 3 },

  // Verbs
  { word: "ran", partOfSpeech: "verb", meaning: "moved fast on your feet", example: "She ran to the bus.", tier: 1 },
  { word: "painted", partOfSpeech: "verb", meaning: "made a picture with paint", example: "He painted a blue whale.", tier: 1 },
  { word: "shouted", partOfSpeech: "verb", meaning: "said something very loudly", example: "They shouted from the field.", tier: 2 },
  { word: "discovered", partOfSpeech: "verb", meaning: "found something for the first time", example: "We discovered a tunnel.", tier: 2 },
  { word: "hesitated", partOfSpeech: "verb", meaning: "waited because you felt unsure", example: "She hesitated at the door.", tier: 3 },
  { word: "wandered", partOfSpeech: "verb", meaning: "walked with no set path", example: "He wandered through the market.", tier: 3 },

  // Adjectives — the four from the MVP, plus more (and "Brilliant" spelled right).
  { word: "shiny", partOfSpeech: "adjective", meaning: "bright, like it catches light", example: "The shiny coin rolled away.", tier: 1 },
  { word: "magical", partOfSpeech: "adjective", meaning: "full of magic", example: "It was a magical night.", tier: 1 },
  { word: "enormous", partOfSpeech: "adjective", meaning: "very, very big", example: "An enormous wave crashed down.", tier: 2 },
  { word: "brilliant", partOfSpeech: "adjective", meaning: "very bright or very clever", example: "She had a brilliant idea.", tier: 2 },
  { word: "brave", partOfSpeech: "adjective", meaning: "willing to do a scary thing", example: "The brave octopus swam out.", tier: 1 },
  { word: "curious", partOfSpeech: "adjective", meaning: "wanting to know more", example: "A curious fox watched us.", tier: 2 },
  { word: "gloomy", partOfSpeech: "adjective", meaning: "dark and a little sad", example: "The gloomy sky matched my mood.", tier: 3 },
  { word: "ancient", partOfSpeech: "adjective", meaning: "extremely old", example: "An ancient map lay open.", tier: 3 },

  // Adverbs — the four from the MVP, plus more.
  { word: "swiftly", partOfSpeech: "adverb", meaning: "in a fast way", example: "He swiftly packed his bag.", tier: 1 },
  { word: "quickly", partOfSpeech: "adverb", meaning: "in a fast way", example: "She quickly raised her hand.", tier: 1 },
  { word: "briskly", partOfSpeech: "adverb", meaning: "fast and full of energy", example: "They walked briskly to class.", tier: 2 },
  { word: "loudly", partOfSpeech: "adverb", meaning: "in a noisy way", example: "The band played loudly.", tier: 1 },
  { word: "carefully", partOfSpeech: "adverb", meaning: "with lots of attention", example: "He carefully carried the eggs.", tier: 2 },
  { word: "silently", partOfSpeech: "adverb", meaning: "without making a sound", example: "The cat crept silently.", tier: 2 },
  { word: "eagerly", partOfSpeech: "adverb", meaning: "in an excited, ready way", example: "We eagerly opened the box.", tier: 3 },
  { word: "reluctantly", partOfSpeech: "adverb", meaning: "in a way that shows you'd rather not", example: "She reluctantly closed her book.", tier: 3 },
] as const;

const rewardItems = [
  { key: "hat-top", name: "Top Hat", slot: "hat", cost: 20, art: "topHat", color: "#FF7A5C", blurb: "For very formal sentences.", sortOrder: 1 },
  { key: "hat-party", name: "Party Hat", slot: "hat", cost: 35, art: "partyHat", color: "#F2A13B", blurb: "Earned after a paragraph or two.", sortOrder: 2 },
  { key: "hat-crown", name: "Word Crown", slot: "hat", cost: 90, art: "crown", color: "#FFC95C", blurb: "For finishing a whole essay.", sortOrder: 3 },
  { key: "hat-grad", name: "Grad Cap", slot: "hat", cost: 150, art: "gradCap", color: "#2A2340", blurb: "Ten pieces of writing. Serious business.", sortOrder: 4 },

  { key: "neck-scarf", name: "Stripy Scarf", slot: "neck", cost: 25, art: "scarf", color: "#2FB6A3", blurb: "Cosy enough for a gloomy paragraph.", sortOrder: 1 },
  { key: "neck-medal", name: "Gold Medal", slot: "neck", cost: 75, art: "medal", color: "#FFC95C", blurb: "Proof you kept going.", sortOrder: 2 },
  { key: "neck-bowtie", name: "Bow Tie", slot: "neck", cost: 40, art: "bowTie", color: "#E4577E", blurb: "Adjectives, but fancy.", sortOrder: 3 },

  { key: "held-pencil", name: "Glowing Pencil", slot: "held", cost: 15, art: "pencil", color: "#F2A13B", blurb: "Where every writer starts.", sortOrder: 1 },
  { key: "held-book", name: "Story Book", slot: "held", cost: 45, art: "book", color: "#5B4E8C", blurb: "Full of words you haven't used yet.", sortOrder: 2 },
  { key: "held-quill", name: "Feather Quill", slot: "held", cost: 110, art: "quill", color: "#7FE3D2", blurb: "For writers with something to say.", sortOrder: 3 },

  { key: "scene-reef", name: "Coral Reef", slot: "scene", cost: 60, art: "reef", color: "#2FB6A3", blurb: "Inki's home water.", sortOrder: 1 },
  { key: "scene-library", name: "Library Nook", slot: "scene", cost: 100, art: "library", color: "#5B4E8C", blurb: "Quiet. Good for essays.", sortOrder: 2 },
  { key: "scene-night", name: "Starry Night", slot: "scene", cost: 130, art: "night", color: "#2A2340", blurb: "For the stories that come out after dark.", sortOrder: 3 },
] as const;

async function seed() {
  await connectDb();

  // Upsert rather than wipe: safe to re-run against a database with real students in it.
  for (const w of words) {
    await WordBankEntry.updateOne(
      { word: w.word, partOfSpeech: w.partOfSpeech },
      { $set: w },
      { upsert: true },
    );
  }
  console.log(`[seed] ${words.length} word bank entries ready`);

  for (const item of rewardItems) {
    await RewardItem.updateOne({ key: item.key }, { $set: item }, { upsert: true });
  }
  console.log(`[seed] ${rewardItems.length} closet items ready`);

  await disconnectDb();
  console.log("[seed] done");
}

seed().catch(async (err) => {
  console.error("[seed] failed", err);
  await disconnectDb();
  process.exit(1);
});
