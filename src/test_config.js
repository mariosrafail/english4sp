// Central place for the fixed exam settings.
// Keep this server-side so the open time cannot be edited from the client.

// Global open time (UTC milliseconds)
// User request: 2026-02-02 17:00 GMT
const OPEN_AT_UTC_MS = Date.parse("2026-02-02T17:00:00.000Z");

// Fixed duration (minutes)
const DURATION_MINUTES = 60;

// Fixed test payload (full, includes correct answers for grading)
const TEST_PAYLOAD_FULL = {
  version: 1,
  randomize: false,
  sections: [
    {
      id: "listening",
      title: "Part 1: Listening",
      description:
        "Listen carefully and answer questions 1 to 8. The listening audio can be played once.",
      rules: { audioPlaysAllowed: 1 },
      items: [
        {
          id: "l1",
          type: "listening-mcq",
          audioUrl:
            "https://www.dropbox.com/scl/fi/7wy95cpxqaqscx677g6oz/listening.mp3?rlkey=1tymlm0mbg6e7xx9lk84sl206&st=h10wyjfs&raw=1",
          prompt: "1. Who is asking for help?",
          choices: ["A tourist.", "A local.", "A shopkeeper."],
          correctIndex: 0,
          points: 1,
        },
        {
          id: "l2",
          type: "listening-mcq",
          prompt: "2. Where is the museum?",
          choices: ["Near the hotel.", "Near the park.", "Near the church."],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "l3",
          type: "listening-mcq",
          prompt: "3. What do Anita and Jorge plan to do while waiting?",
          choices: ["Go home.", "Get coffee.", "Call the store."],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "l4",
          type: "listening-mcq",
          prompt: "4. Why does Jorge want to sit inside the cafe?",
          choices: ["He doesn't like the park.", "It's raining.", "It's cold."],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "l5",
          type: "listening-mcq",
          prompt: "5. What does Stephen initially suggest for dinner?",
          choices: [
            "The new Italian restaurant.",
            "The pizzeria.",
            "Cooking at home.",
          ],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "l6",
          type: "listening-mcq",
          prompt: "6. Why does Lisa want to go to the new Italian restaurant tonight?",
          choices: [
            "She has never been to a pizzeria.",
            "She wants to try the new place and its pasta.",
            "She prefers pizza over pasta.",
          ],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "l7",
          type: "tf",
          prompt: "7. The guide will first take the tourists to the historic old town.",
          correct: false,
          points: 1,
        },
        {
          id: "l8",
          type: "tf",
          prompt: "8. They will visit the city gardens.",
          correct: true,
          points: 1,
        },
      ],
    },
    {
      id: "reading",
      title: "Part 2: Reading",
      items: [
        {
          id: "r_intro_1",
          type: "info",
          prompt:
            "Exercise A (Questions 1-4)\nWelcome to Sunny Beach Hotel! Our hotel offers comfortable rooms with sea views, a swimming pool, and a restaurant serving local and international cuisine. Check-in is from 2 pm, and check-out is by 11 am. We look forward to making your stay enjoyable.",
          points: 0,
        },
        {
          id: "r1",
          type: "mcq",
          prompt: "1. The Sunny Beach Hotel offers rooms with:",
          choices: ["city views", "sea views", "mountain views"],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "r2",
          type: "mcq",
          prompt:
            "2. The hotel facilities include a swimming pool and a:",
          choices: ["gym", "conference hall", "restaurant"],
          correctIndex: 2,
          points: 1,
        },
        {
          id: "r3",
          type: "mcq",
          prompt: "3. Check-in time at the hotel is:",
          choices: ["from 2 pm", "from 4 pm", "from 6 pm"],
          correctIndex: 0,
          points: 1,
        },
        {
          id: "r4",
          type: "mcq",
          prompt: "4. The restaurant serves:",
          choices: [
            "local cuisine",
            "vegan cuisine",
            "international and vegan cuisine",
          ],
          correctIndex: 0,
          points: 1,
        },
        {
          id: "r_intro_2",
          type: "info",
          prompt:
            "Exercise B (Questions 5-8)\nCrete is Greece's largest island, full of mountains, beaches, and ancient history. Visitors explore ancient ruins, like Knossos, and learn about the mythical Minotaur. In towns and villages, life moves at a relaxed pace, with friendly locals and tasty food. The sea borders many coastline towns, offering fresh water and fresh seafood. Hiking on the hills is a pleasure, and one can see olive groves and traditional windmills. Crete is a place where culture, nature, and hospitality come together to welcome travellers.",
          points: 0,
        },
        {
          id: "r5",
          type: "mcq",
          prompt: "5. Which of the following best describes Crete?",
          choices: [
            "A large city in Greece with skyscrapers.",
            "Greece's largest island with mountains and beaches.",
            "A small island known only for its beaches.",
          ],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "r6",
          type: "mcq",
          prompt:
            "6. What ancient site is mentioned as an example of ruins to explore?",
          choices: ["Acropolis", "Knossos", "Delphi"],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "r7",
          type: "mcq",
          prompt:
            "7. According to the text, how is life in towns and villages described?",
          choices: [
            "Busy with crowded streets.",
            "Industrial and modern with fast food.",
            "Quiet and traditional with friendly locals.",
          ],
          correctIndex: 2,
          points: 1,
        },
        {
          id: "r8",
          type: "mcq",
          prompt:
            "8. Which features are mentioned as part of Crete's landscape and culture?",
          choices: [
            "Olive groves, clear coastal water and fresh seafood.",
            "Rainforests and large metropolitan museums.",
            "Snowy mountains and ski resorts.",
          ],
          correctIndex: 0,
          points: 1,
        },
      ],
    },
    {
      id: "writing",
      title: "Part 3: Writing",
      items: [
        {
          id: "w_intro",
          type: "info",
          prompt:
            "Task 1 (Questions 1-4): Choose the correct word to fill each gap.\nWord bank: cool, to, streets, plants, at, raincoat",
          points: 0,
        },
        {
          id: "w1",
          type: "mcq",
          prompt: "1. Rain makes the ______ shine.",
          choices: ["cool", "to", "streets", "plants", "at", "raincoat"],
          correctIndex: 2,
          points: 1,
        },
        {
          id: "w2",
          type: "mcq",
          prompt: "2. The air smells clean and ______.",
          choices: ["cool", "to", "streets", "plants", "at", "raincoat"],
          correctIndex: 0,
          points: 1,
        },
        {
          id: "w3",
          type: "mcq",
          prompt: "3. I put on my ______ and boots.",
          choices: ["cool", "to", "streets", "plants", "at", "raincoat"],
          correctIndex: 5,
          points: 1,
        },
        {
          id: "w4",
          type: "mcq",
          prompt: "4. I like rain because it helps ______ grow.",
          choices: ["cool", "to", "streets", "plants", "at", "raincoat"],
          correctIndex: 3,
          points: 1,
        },
        {
          id: "q4",
          type: "writing",
          prompt:
            "Task 2: Write a 50-word email to a guest confirming their reservation. Include guest name, check-in date, number of nights, and a special diet request.",
          points: 0,
        },
      ],
    },
  ],
};

function getTestPayloadFull() {
  return TEST_PAYLOAD_FULL;
}

function getTestPayloadForClient() {
  // Strip correct answers
  const payload = JSON.parse(JSON.stringify(TEST_PAYLOAD_FULL));
  for (const sec of payload.sections || []) {
    for (const item of sec.items || []) {
      delete item.correctIndex;
      delete item.correct;
      delete item.correctText;
    }
  }
  return payload;
}

function getConfig() {
  return {
    serverNow: Date.now(),
    openAtUtc: OPEN_AT_UTC_MS,
    durationMinutes: DURATION_MINUTES,
  };
}

module.exports = {
  OPEN_AT_UTC_MS,
  DURATION_MINUTES,
  getTestPayloadFull,
  getTestPayloadForClient,
  getConfig,
};
