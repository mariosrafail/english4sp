// Central place for the fixed exam settings.
// Keep this server-side so the open time cannot be edited from the client.

// Global open time (UTC milliseconds)
// User request: 2026-02-02 17:00 GMT
const OPEN_AT_UTC_MS = Date.parse("2026-02-02T17:00:00.000Z");

// Fixed duration
const DURATION_SECONDS = 3600;

// Fixed test payload (full, includes correct answers for grading)
const TEST_PAYLOAD_FULL = {
  version: 1,
  sections: [
    {
      id: "reading",
      title: "Reading",
      items: [
        {
          id: "q1",
          type: "mcq",
          prompt: "Choose the best answer: I have lived in Athens ___ 2018.",
          choices: ["for", "since", "during"],
          correctIndex: 1,
          points: 1,
        },
        {
          id: "q2",
          type: "tf",
          prompt: "True or False: 'He don't like coffee' is grammatically correct.",
          correct: false,
          points: 1,
        },
      ],
    },
    {
      id: "listening",
      title: "Listening",
      rules: { audioPlaysAllowed: 1 },
      items: [
        {
          id: "q3",
          type: "listening-mcq",
          audioUrl: "/beep.wav",
          prompt: "Listen once. Which option matches the sound you heard?",
          choices: ["A short beep", "A long melody", "Silence"],
          correctIndex: 0,
          points: 1,
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
    durationSeconds: DURATION_SECONDS,
  };
}

module.exports = {
  OPEN_AT_UTC_MS,
  DURATION_SECONDS,
  getTestPayloadFull,
  getTestPayloadForClient,
  getConfig,
};
