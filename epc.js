const steps = [...document.querySelectorAll(".epc-step")];
const nextBtn = document.getElementById("nextBtn");
const prevBtn = document.getElementById("prevBtn");
const form = document.getElementById("epcForm");

let currentStep = 1;

const answers = {};

const questionNames = {
  1: "propertyType",
  2: "age",
  3: "walls",
  4: "loft",
  5: "windows",
  6: "heating"
};

function selectedForStep(step) {
  const name = questionNames[step];
  return form.querySelector(`input[name="${name}"]:checked`)?.value || null;
}

function updateProgress() {
  const pct = (currentStep / 6) * 100;

  document.getElementById("questionCounter").textContent =
    `Question ${currentStep} of 6`;

  document.getElementById("progressPercent").textContent =
    `${Math.round(pct)}%`;

  document.getElementById("progressBar").style.width = `${pct}%`;

  prevBtn.disabled = currentStep === 1;

  const hasAnswer = Boolean(selectedForStep(currentStep));
  nextBtn.disabled = !hasAnswer;
  nextBtn.textContent = currentStep === 6 ? "See my estimate" : "Continue";
}

function showStep(step) {
  steps.forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === step);
  });

  currentStep = step;
  updateProgress();
  updatePreview();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function collectAnswers() {
  Object.values(questionNames).forEach((name) => {
    answers[name] = form.querySelector(`input[name="${name}"]:checked`)?.value || null;
  });
}

function calculateScore() {
  collectAnswers();

  let score = 48;
  let unknowns = 0;

  const propertyScores = {
    flat: 8,
    terrace: 5,
    semi: 2,
    detached: -3
  };

  const ageScores = {
    pre1919: -12,
    "1919_1975": -7,
    "1976_1990": -2,
    "1991_2005": 6,
    "2006plus": 15
  };

  const wallScores = {
    none: -10,
    unknown: 0,
    cavity: 10,
    solid: 13
  };

  const loftScores = {
    none: -9,
    some: -3,
    good: 7,
    excellent: 11
  };

  const windowScores = {
    single: -8,
    mixed: -3,
    double: 7,
    triple: 10
  };

  const heatingScores = {
    electric: -5,
    oldboiler: -8,
    modernboiler: 8,
    heatpump: 15
  };

  score += propertyScores[answers.propertyType] || 0;
  score += ageScores[answers.age] || 0;
  score += wallScores[answers.walls] || 0;
  score += loftScores[answers.loft] || 0;
  score += windowScores[answers.windows] || 0;
  score += heatingScores[answers.heating] || 0;

  if (answers.walls === "unknown") unknowns += 1;

  score = Math.max(12, Math.min(96, Math.round(score)));

  return { score, unknowns };
}

function bandFor(score) {
  if (score >= 92) return "A";
  if (score >= 81) return "B";
  if (score >= 69) return "C";
  if (score >= 55) return "D";
  if (score >= 39) return "E";
  if (score >= 21) return "F";
  return "G";
}

function previewScore() {
  collectAnswers();

  const answered = Object.values(answers).filter(Boolean).length;

  if (!answered) {
    return { band: "?", text: "Answer the questions to build your estimate." };
  }

  const complete = Object.values(answers).every(Boolean);

  if (complete) {
    const result = calculateScore();
    return {
      band: bandFor(result.score),
      text: `Current estimate: ${result.score} points.`
    };
  }

  return {
    band: "...",
    text: `${answered} of 6 answers collected.`
  };
}

function updatePreview() {
  const preview = previewScore();
  document.getElementById("previewBand").textContent = preview.band;
  document.getElementById("previewText").textContent = preview.text;
}

function improvements() {
  const items = [];

  if (answers.walls === "none" || answers.walls === "unknown") {
    items.push({
      title: "Improve wall insulation",
      copy: "Wall insulation is one of the biggest missing efficiency signals in your answers."
    });
  }

  if (answers.loft === "none" || answers.loft === "some") {
    items.push({
      title: "Top up loft insulation",
      copy: "Increasing roof insulation is often one of the simpler ways to reduce heat loss."
    });
  }

  if (answers.windows === "single" || answers.windows === "mixed") {
    items.push({
      title: "Upgrade the glazing",
      copy: "Modern double glazing can reduce heat loss and improve comfort."
    });
  }

  if (answers.heating === "oldboiler" || answers.heating === "electric") {
    items.push({
      title: "Review the heating system",
      copy: "A more efficient heating system could materially improve the estimated rating."
    });
  }

  if (!items.length) {
    items.push({
      title: "Fine-tune controls and renewables",
      copy: "Your six headline answers are already strong. Heating controls, solar and airtightness could be the next areas to investigate."
    });
  }

  return items.slice(0, 3);
}

function showResult() {
  const { score, unknowns } = calculateScore();
  const band = bandFor(score);

  document.getElementById("scoreValue").textContent = score;
  document.getElementById("resultBadge").textContent = band;

  document.getElementById("resultSummary").textContent =
    `Your six answers suggest a rating around band ${band}.`;

  document.getElementById("confidenceValue").textContent =
    unknowns > 0 ? "Low to medium" : "Medium";

  document.querySelectorAll(".epc-band").forEach((el) => {
    el.classList.toggle(
      "active",
      el.querySelector("span").textContent === band
    );
  });

  document.getElementById("improvementList").innerHTML =
    improvements().map((item) => `
      <div class="improvement-item">
        <strong>${item.title}</strong>
        <span>${item.copy}</span>
      </div>
    `).join("");

  document.querySelector(".epc-workspace").classList.add("hidden");
  document.querySelector(".epc-progress-shell").classList.add("hidden");
  document.getElementById("epcResult").classList.remove("hidden");

  document.getElementById("epcResult").scrollIntoView({ behavior: "smooth" });
}

form.addEventListener("change", () => {
  updateProgress();
  updatePreview();
});

nextBtn.addEventListener("click", () => {
  if (!selectedForStep(currentStep)) return;

  if (currentStep < 6) {
    showStep(currentStep + 1);
  } else {
    showResult();
  }
});

prevBtn.addEventListener("click", () => {
  if (currentStep > 1) showStep(currentStep - 1);
});

document.getElementById("restartBtn").addEventListener("click", () => {
  form.reset();
  document.getElementById("epcResult").classList.add("hidden");
  document.querySelector(".epc-workspace").classList.remove("hidden");
  document.querySelector(".epc-progress-shell").classList.remove("hidden");
  showStep(1);
});

updateProgress();
updatePreview();
