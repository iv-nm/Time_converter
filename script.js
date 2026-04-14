const DEFAULT_SOURCE_QUERY = "Edmonton";
const DEFAULT_DESTINATION_QUERY = "Tokyo";
const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const WIKIMEDIA_API = "https://en.wikipedia.org/w/api.php";
const SVG_NS = "http://www.w3.org/2000/svg";

const elements = {
  app: document.querySelector("#app"),
  alignForm: document.querySelector("#align-form"),
  alignTrigger: document.querySelector("#align-trigger"),
  editTrigger: document.querySelector("#edit-trigger"),
  sourceCityInput: document.querySelector("#source-city-input"),
  destinationCityInput: document.querySelector("#destination-city-input"),
  sourceSuggestions: document.querySelector("#source-city-suggestions"),
  destinationSuggestions: document.querySelector("#destination-city-suggestions"),
  sourceDate: document.querySelector("#source-date"),
  sourceTime: document.querySelector("#source-time"),
  sourceVisual: document.querySelector("#source-visual"),
  destinationVisual: document.querySelector("#destination-visual"),
  lookupStatus: document.querySelector("#lookup-status"),
  sourceRing: document.querySelector("#source-ring"),
  destinationRing: document.querySelector("#destination-ring"),
  sourceMarkerLayer: document.querySelector("#source-marker-layer"),
  destinationMarkerLayer: document.querySelector("#destination-marker-layer"),
  alignmentTime: document.querySelector("#alignment-time"),
  alignmentDetail: document.querySelector("#alignment-detail"),
  sourceHeading: document.querySelector("#source-heading"),
  destinationHeading: document.querySelector("#destination-heading"),
  sourcePreview: document.querySelector("#source-preview"),
  destinationPreview: document.querySelector("#destination-preview"),
  differencePreview: document.querySelector("#difference-preview"),
  differenceDayShift: document.querySelector("#difference-day-shift")
};

const state = {
  sourcePlace: null,
  destinationPlace: null,
  latestSuggestions: {
    source: [],
    destination: []
  },
  searchToken: {
    source: 0,
    destination: 0
  },
  imageToken: 0,
  scene: "compose",
  isAligning: false
};

const imageCache = new Map();

function setSceneState(nextState) {
  state.scene = nextState;
  elements.app.classList.remove("scene--compose", "scene--animating", "scene--revealed");
  elements.app.classList.add(`scene--${nextState}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function createFormatter(locale, options) {
  return new Intl.DateTimeFormat(locale, options);
}

function getParts(date, timeZone) {
  const formatter = createFormatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  return formatter
    .formatToParts(date)
    .filter((part) => part.type !== "literal")
    .reduce((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});
}

function getOffsetMinutes(date, timeZone) {
  const parts = getParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return (asUtc - date.getTime()) / 60000;
}

function localDateTimeToInstant(dateValue, timeValue, timeZone) {
  if (!dateValue || !timeValue || !timeZone) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);

  const initialOffset = getOffsetMinutes(new Date(guess), timeZone);
  let timestamp = guess - initialOffset * 60000;

  const refinedOffset = getOffsetMinutes(new Date(timestamp), timeZone);
  if (refinedOffset !== initialOffset) {
    timestamp = guess - refinedOffset * 60000;
  }

  return new Date(timestamp);
}

function formatDetailed(date, timeZone) {
  return createFormatter("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatShortClock(date, timeZone) {
  return createFormatter("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatDialClock(date, timeZone) {
  const parts = getParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

function formatOffset(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const mins = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${mins}`;
}

function formatDifference(sourceOffset, destinationOffset) {
  const deltaMinutes = destinationOffset - sourceOffset;
  const sign = deltaMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(deltaMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const duration = minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  return `${sign}${duration}`;
}

function describeDayShift(sourceInstant, sourcePlace, destinationPlace) {
  const sourceParts = getParts(sourceInstant, sourcePlace.timezone);
  const destinationParts = getParts(sourceInstant, destinationPlace.timezone);
  const sourceStamp = Date.UTC(
    Number(sourceParts.year),
    Number(sourceParts.month) - 1,
    Number(sourceParts.day)
  );
  const destinationStamp = Date.UTC(
    Number(destinationParts.year),
    Number(destinationParts.month) - 1,
    Number(destinationParts.day)
  );
  const delta = Math.round((destinationStamp - sourceStamp) / 86400000);

  if (delta === 0) {
    return "Same Day";
  }

  if (delta === 1) {
    return "Next Day";
  }

  if (delta === -1) {
    return "Previous Day";
  }

  return delta > 0 ? `+${delta} Days` : `${delta} Days`;
}

function buildPlaceLabel(place) {
  const region = place.admin1 ? `${place.admin1}, ` : "";
  return `${place.name}, ${region}${place.country}`;
}

function buildPlaceCode(place) {
  const words = place.name
    .split(/[\s-]+/)
    .map((part) => part.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);

  if (words.length >= 2) {
    return words
      .slice(0, 3)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }

  const condensed = words[0] || place.name.replace(/[^A-Za-z]/g, "");
  return condensed.slice(0, 3).toUpperCase();
}

function normalizePlaceText(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function setLookupMessage(message) {
  elements.lookupStatus.textContent = message;
}

function buildGeocodingUrl(query) {
  const url = new URL(GEOCODING_API);
  url.searchParams.set("name", query);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  return url.toString();
}

function buildWikipediaSearchUrl(place) {
  const url = new URL(WIKIMEDIA_API);
  url.searchParams.set("origin", "*");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrlimit", "1");
  url.searchParams.set("gsrsearch", `${place.name} ${place.country}`);
  url.searchParams.set("prop", "pageimages");
  url.searchParams.set("piprop", "thumbnail|original|name");
  url.searchParams.set("pithumbsize", "1800");
  return url.toString();
}

async function searchPlaces(query) {
  if (!query || query.trim().length < 2) {
    return [];
  }

  try {
    const response = await fetch(buildGeocodingUrl(query.trim()));
    if (!response.ok) {
      throw new Error(`Lookup failed with ${response.status}`);
    }

    const data = await response.json();
    return (data.results || []).filter((place) => place.timezone);
  } catch (error) {
    return [];
  }
}

function fillSuggestionList(which, places) {
  const datalist =
    which === "source" ? elements.sourceSuggestions : elements.destinationSuggestions;
  datalist.innerHTML = "";

  places.forEach((place) => {
    const option = document.createElement("option");
    option.value = buildPlaceLabel(place);
    datalist.append(option);
  });
}

async function updateSuggestions(which) {
  const input =
    which === "source" ? elements.sourceCityInput : elements.destinationCityInput;
  const token = ++state.searchToken[which];
  const places = await searchPlaces(input.value);

  if (token !== state.searchToken[which]) {
    return;
  }

  state.latestSuggestions[which] = places;
  fillSuggestionList(which, places);
}

function pickMatchedSuggestion(which, rawValue) {
  const normalized = normalizePlaceText(rawValue);
  return state.latestSuggestions[which].find((place) => {
    return normalizePlaceText(buildPlaceLabel(place)) === normalized;
  });
}

function buildSearchQueries(rawValue) {
  const parts = rawValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const queries = [rawValue.trim()];

  if (parts.length > 1) {
    queries.push(parts.slice(0, 2).join(", "));
    queries.push(parts[0]);
  }

  return [...new Set(queries.filter(Boolean))];
}

async function resolvePlaceFromQuery(rawValue) {
  const queries = buildSearchQueries(rawValue);

  for (const query of queries) {
    const matches = await searchPlaces(query);
    if (matches.length > 0) {
      return matches[0];
    }
  }

  return null;
}

function syncRevealText() {
  elements.sourceHeading.textContent = state.sourcePlace ? state.sourcePlace.name : "";
  elements.destinationHeading.textContent = state.destinationPlace ? state.destinationPlace.name : "";
}

async function resolvePlace(which, rawValue) {
  const query = rawValue.trim();
  if (!query) {
    return false;
  }

  const matched = pickMatchedSuggestion(which, query);
  const chosen = matched || (await resolvePlaceFromQuery(query));

  if (!chosen) {
    setLookupMessage(`No city match found for "${query}".`);
    return false;
  }

  state.latestSuggestions[which] = [chosen];
  fillSuggestionList(which, [chosen]);

  if (which === "source") {
    state.sourcePlace = chosen;
    elements.sourceCityInput.value = buildPlaceLabel(chosen);
  } else {
    state.destinationPlace = chosen;
    elements.destinationCityInput.value = buildPlaceLabel(chosen);
  }

  syncRevealText();
  return true;
}

function createSvgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => {
    node.setAttribute(key, String(value));
  });
  return node;
}

function polarToCartesian(radius, angleDegrees) {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: 180 + radius * Math.cos(radians),
    y: 180 + radius * Math.sin(radians)
  };
}

function buildDialRing(group, options) {
  group.innerHTML = "";

  for (let hour = 0; hour < 24; hour += 1) {
    const angle = (hour / 24) * 360;
    const outer = polarToCartesian(options.radius, angle);
    const inner = polarToCartesian(
      options.radius - (hour % 6 === 0 ? 18 : hour % 3 === 0 ? 12 : 7),
      angle
    );
    group.append(
      createSvgElement("line", {
        x1: outer.x,
        y1: outer.y,
        x2: inner.x,
        y2: inner.y,
        class: "dial-hour-tick"
      })
    );

    if (hour % options.labelEvery !== 0) {
      continue;
    }

    const labelPoint = polarToCartesian(options.labelRadius, angle);
    const label = createSvgElement("text", {
      x: labelPoint.x,
      y: labelPoint.y,
      class: `dial-hour-label ${options.labelClass}`.trim()
    });
    label.textContent = String(hour).padStart(2, "0");
    group.append(label);
  }

  if (options.showNeedle === false) {
    return;
  }

  group.append(
    createSvgElement("line", {
      x1: 180,
      y1: 180,
      x2: 180,
      y2: options.needleY,
      class: `dial-city-needle ${options.needleClass}`.trim()
    }),
    createSvgElement("circle", {
      cx: 180,
      cy: options.dotY,
      r: options.dotRadius,
      class: `dial-city-dot ${options.dotClass}`.trim()
    })
  );
}

function clearMarkerLayer(layer) {
  layer.innerHTML = "";
}

function renderDialMarker(layer, options) {
  clearMarkerLayer(layer);

  const point = polarToCartesian(options.radius, options.angle);
  const lineStart = polarToCartesian(options.lineStartRadius ?? options.radius, options.angle);
  const labelPoint = polarToCartesian(
    options.labelRadius ?? options.radius,
    options.angle
  );
  const anchor =
    options.textAnchor ?? (labelPoint.x >= 180 ? "start" : "end");
  const xOffset =
    options.labelOffsetX ?? (anchor === "start" ? 8 : anchor === "end" ? -8 : 0);
  const yOffset = options.labelOffsetY ?? 0;

  if (options.showConnector !== false) {
    layer.append(
      createSvgElement("line", {
        x1: lineStart.x,
        y1: lineStart.y,
        x2: labelPoint.x,
        y2: labelPoint.y,
        class: "dial-marker-connector"
      })
    );
  }

  if (options.showDot !== false) {
    layer.append(
      createSvgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: options.dotRadius,
        class: `dial-marker-dot ${options.dotClass}`.trim()
      })
    );
  }

  const label = createSvgElement("text", {
    x: labelPoint.x + xOffset,
    y: labelPoint.y + yOffset,
    class: `dial-marker-label ${options.labelClass}`.trim(),
    "text-anchor": anchor,
    "dominant-baseline": "central"
  });
  label.textContent = options.text;
  layer.append(label);
}

function initializeDial() {
  buildDialRing(elements.sourceRing, {
    radius: 152,
    labelRadius: 132,
    labelEvery: 2,
    labelClass: "",
    showNeedle: false,
    needleY: 48,
    needleClass: "dial-city-needle--source",
    dotY: 36,
    dotRadius: 6,
    dotClass: "dial-city-dot--source"
  });

  buildDialRing(elements.destinationRing, {
    radius: 118,
    labelRadius: 100,
    labelEvery: 3,
    labelClass: "dial-hour-label--destination",
    showNeedle: false,
    needleY: 88,
    needleClass: "dial-city-needle--destination",
    dotY: 76,
    dotRadius: 5,
    dotClass: "dial-city-dot--destination"
  });
}

function setRingRotation(group, minutesOfDay) {
  const angle = (minutesOfDay / 1440) * 360;
  group.setAttribute("transform", `rotate(${-angle} 180 180)`);
}

function animateRingTo(group, minutesOfDay, extraTurns) {
  const finalAngle = (minutesOfDay / 1440) * 360;
  group.style.transition = "none";
  group.setAttribute("transform", `rotate(${-finalAngle - extraTurns} 180 180)`);

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      group.style.transition = "transform 1200ms cubic-bezier(0.22, 1, 0.36, 1)";
      setRingRotation(group, minutesOfDay);
    });
  });
}

function getConversionState() {
  if (!state.sourcePlace || !state.destinationPlace) {
    return null;
  }

  const instant = localDateTimeToInstant(
    elements.sourceDate.value,
    elements.sourceTime.value,
    state.sourcePlace.timezone
  );

  if (!instant || Number.isNaN(instant.getTime())) {
    return null;
  }

  const sourceOffset = getOffsetMinutes(instant, state.sourcePlace.timezone);
  const destinationOffset = getOffsetMinutes(instant, state.destinationPlace.timezone);
  const sourceParts = getParts(instant, state.sourcePlace.timezone);
  const destinationParts = getParts(instant, state.destinationPlace.timezone);
  const sourceMinutesOfDay = Number(sourceParts.hour) * 60 + Number(sourceParts.minute);
  const destinationMinutesOfDay =
    Number(destinationParts.hour) * 60 + Number(destinationParts.minute);

  return {
    instant,
    sourceOffset,
    destinationOffset,
    sourceMinutesOfDay,
    destinationMinutesOfDay
  };
}

function renderConversion() {
  syncRevealText();

  if (!state.sourcePlace || !state.destinationPlace) {
    elements.alignmentTime.textContent = "";
    elements.alignmentDetail.textContent = "Write both places to plot their markers around the dial.";
    elements.sourcePreview.textContent = "";
    elements.destinationPreview.textContent = "";
    elements.differencePreview.textContent = "";
    elements.differenceDayShift.textContent = "";
    clearMarkerLayer(elements.sourceMarkerLayer);
    clearMarkerLayer(elements.destinationMarkerLayer);
    return null;
  }

  const conversion = getConversionState();

  if (!conversion) {
    elements.alignmentTime.textContent = "";
    elements.alignmentDetail.textContent = "Add a date and time to rotate both city markers into place.";
    elements.sourcePreview.textContent = "";
    elements.destinationPreview.textContent = "";
    elements.differencePreview.textContent = "";
    elements.differenceDayShift.textContent = "";
    clearMarkerLayer(elements.sourceMarkerLayer);
    clearMarkerLayer(elements.destinationMarkerLayer);
    return null;
  }

  elements.sourcePreview.textContent = `${formatDetailed(
    conversion.instant,
    state.sourcePlace.timezone
  )} • ${formatOffset(conversion.sourceOffset)}`;
  elements.destinationPreview.textContent = `${formatDetailed(
    conversion.instant,
    state.destinationPlace.timezone
  )} • ${formatOffset(conversion.destinationOffset)}`;
  elements.differencePreview.textContent = formatDifference(
    conversion.sourceOffset,
    conversion.destinationOffset
  );
  elements.differenceDayShift.textContent = describeDayShift(
    conversion.instant,
    state.sourcePlace,
    state.destinationPlace
  );
  if (state.scene === "revealed") {
    elements.alignmentTime.textContent = `${formatShortClock(
      conversion.instant,
      state.sourcePlace.timezone
    )} ↔ ${formatShortClock(conversion.instant, state.destinationPlace.timezone)}`;
    elements.alignmentDetail.textContent = `${state.sourcePlace.name} rotates into ${state.destinationPlace.name} on one meridian.`;
  } else {
    elements.alignmentTime.textContent = "";
    elements.alignmentDetail.textContent = `${state.sourcePlace.name} and ${state.destinationPlace.name} are ${formatDifference(
      conversion.sourceOffset,
      conversion.destinationOffset
    )} apart on the dial.`;
  }

  setRingRotation(elements.sourceRing, conversion.sourceMinutesOfDay);
  setRingRotation(elements.destinationRing, conversion.destinationMinutesOfDay);
  renderDialMarker(elements.sourceMarkerLayer, {
    lineStartRadius: 0,
    radius: 144,
    labelRadius: 194,
    angle: (conversion.sourceMinutesOfDay / 1440) * 360,
    dotRadius: 4.2,
    dotClass: "dial-marker-dot--source",
    labelClass: "dial-marker-label--source dial-arrow-info dial-arrow-info--source",
    text: `${buildPlaceCode(state.sourcePlace)} ${formatDialClock(
      conversion.instant,
      state.sourcePlace.timezone
    )}`
  });
  renderDialMarker(elements.destinationMarkerLayer, {
    lineStartRadius: 0,
    radius: 104,
    labelRadius: 148,
    angle: (conversion.destinationMinutesOfDay / 1440) * 360,
    dotRadius: 3.6,
    dotClass: "dial-marker-dot--destination",
    labelClass:
      "dial-marker-label--destination dial-arrow-info dial-arrow-info--destination",
    text: `${buildPlaceCode(state.destinationPlace)} ${formatDialClock(
      conversion.instant,
      state.destinationPlace.timezone
    )}`
  });

  return conversion;
}

async function fetchCityImage(place) {
  const cacheKey = `${place.name}|${place.country}`;
  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  try {
    const response = await fetch(buildWikipediaSearchUrl(place));
    if (!response.ok) {
      throw new Error(`Image request failed with ${response.status}`);
    }

    const data = await response.json();
    const page = data.query?.pages?.[0];
    const imageUrl = page?.original?.source || page?.thumbnail?.source || null;
    imageCache.set(cacheKey, imageUrl);
    return imageUrl;
  } catch (error) {
    imageCache.set(cacheKey, null);
    return null;
  }
}

function applyCityImage(target, imageUrl, fallback) {
  const overlay = "linear-gradient(180deg, rgba(10, 10, 14, 0.12), rgba(10, 10, 14, 0.8))";
  target.style.backgroundImage = imageUrl ? `${overlay}, url("${imageUrl}")` : `${overlay}, ${fallback}`;
  target.style.backgroundSize = "cover";
  target.style.backgroundPosition = "center";
}

async function refreshImages() {
  if (!state.sourcePlace || !state.destinationPlace) {
    return;
  }

  const token = ++state.imageToken;
  const [sourceImage, destinationImage] = await Promise.all([
    fetchCityImage(state.sourcePlace),
    fetchCityImage(state.destinationPlace)
  ]);

  if (token !== state.imageToken) {
    return;
  }

  applyCityImage(
    elements.sourceVisual,
    sourceImage,
    "linear-gradient(135deg, #4b4f57, #17191d)"
  );
  applyCityImage(
    elements.destinationVisual,
    destinationImage,
    "linear-gradient(135deg, #2d3138, #0f1115)"
  );
}

function debounce(callback, delayMs) {
  let timeoutId = 0;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delayMs);
  };
}

function handleFieldEdit() {
  if (state.scene === "revealed") {
    setSceneState("compose");
  }
}

function setInputsToCurrentSourceTime() {
  if (!state.sourcePlace) {
    return;
  }

  const parts = getParts(new Date(), state.sourcePlace.timezone);
  elements.sourceDate.value = `${parts.year}-${parts.month}-${parts.day}`;
  elements.sourceTime.value = `${parts.hour}:${parts.minute}`;
}

async function preparePlaces() {
  setLookupMessage("Resolving cities...");
  const [sourceResolved, destinationResolved] = await Promise.all([
    resolvePlace("source", elements.sourceCityInput.value),
    resolvePlace("destination", elements.destinationCityInput.value)
  ]);

  if (!sourceResolved || !destinationResolved) {
    return false;
  }

  setLookupMessage(
    `${state.sourcePlace.name} and ${state.destinationPlace.name} are mapped.`
  );
  return true;
}

async function handleAlign(event) {
  event.preventDefault();
  if (state.isAligning) {
    return;
  }

  state.isAligning = true;
  elements.alignTrigger.disabled = true;

  const prepared = await preparePlaces();
  const conversion = prepared ? renderConversion() : null;

  if (!conversion) {
    state.isAligning = false;
    elements.alignTrigger.disabled = false;
    if (prepared) {
      setLookupMessage("Choose a valid date and time first.");
    }
    return;
  }

  setLookupMessage(
    `Tracing the line between ${state.sourcePlace.name} and ${state.destinationPlace.name}...`
  );

  const imagePromise = refreshImages();
  setSceneState("animating");
  animateRingTo(elements.sourceRing, conversion.sourceMinutesOfDay, 720);
  animateRingTo(elements.destinationRing, conversion.destinationMinutesOfDay, 900);

  await Promise.all([delay(1300), imagePromise]);

  renderConversion();
  setSceneState("revealed");
  setLookupMessage(
    `${state.sourcePlace.name} and ${state.destinationPlace.name} align at the selected moment.`
  );

  state.isAligning = false;
  elements.alignTrigger.disabled = false;
}

function wireLookup(which) {
  const input =
    which === "source" ? elements.sourceCityInput : elements.destinationCityInput;
  const debouncedSuggestions = debounce(() => {
    updateSuggestions(which);
  }, 220);

  input.addEventListener("input", () => {
    handleFieldEdit();
    debouncedSuggestions();
  });

  input.addEventListener("change", async () => {
    await resolvePlace(which, input.value);
    renderConversion();
  });

  input.addEventListener("blur", async () => {
    await resolvePlace(which, input.value);
    renderConversion();
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    await resolvePlace(which, input.value);
    renderConversion();
  });
}

function wireFormFields() {
  [elements.sourceDate, elements.sourceTime].forEach((field) => {
    field.addEventListener("input", () => {
      handleFieldEdit();
      renderConversion();
    });
  });
}

async function init() {
  setSceneState("compose");
  initializeDial();

  elements.sourceCityInput.value = DEFAULT_SOURCE_QUERY;
  elements.destinationCityInput.value = DEFAULT_DESTINATION_QUERY;

  await preparePlaces();
  setInputsToCurrentSourceTime();
  renderConversion();
  refreshImages();

  wireLookup("source");
  wireLookup("destination");
  wireFormFields();

  elements.alignForm.addEventListener("submit", handleAlign);
  elements.editTrigger.addEventListener("click", () => {
    setSceneState("compose");
    setLookupMessage("Edit the cities or time, then align again.");
  });
}

init();
