// plant-care-card.js
// Custom Home Assistant Lovelace card for plant care management.
// Combines Miflora/Zigbee sensor readings with Planta integration
// care schedules and action buttons, with smart moisture-aware logic.
//
// Installation: copy to /config/www/plant-care-card.js and add as a
// Lovelace resource, or install via HACS (custom repository).

const CARD_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — CONSTANTS & LOW-LEVEL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Care action definitions — order controls render order
const CARE_ACTIONS = [
  { key: 'water',     label: 'Water',     icon: 'mdi:water'        },
  { key: 'mist',      label: 'Mist',      icon: 'mdi:weather-fog'  },
  { key: 'fertilize', label: 'Fertilize', icon: 'mdi:sprout'       },
  { key: 'repot',     label: 'Repot',     icon: 'mdi:pot-mix'      },
];

// Care status values
const STATUS = {
  URGENT:    'urgent',    // moisture below min — water regardless of schedule
  DUE:       'due',       // scheduled care is due
  SKIP:      'skip',      // moisture above max — skip watering even if due
  AVAILABLE: 'available', // not due but action is available
};

// Fallback unit labels (used when HA's unit_of_measurement attribute is absent)
const SENSOR_UNITS = {
  temperature:  '°C',
  illuminance:  'lx',
  conductivity: 'µS/cm',
  moisture:     '%',
};

/**
 * Returns a state object from hass.states, or null if the entity is missing,
 * unavailable, or unknown.
 */
function getState(hass, entityId) {
  if (!entityId || !hass) return null;
  const s = hass.states[entityId];
  if (!s || s.state === 'unavailable' || s.state === 'unknown') return null;
  return s;
}

/**
 * Returns the numeric value of a sensor entity, or null if unavailable/NaN.
 */
function numericState(hass, entityId) {
  const s = getState(hass, entityId);
  if (!s) return null;
  const n = parseFloat(s.state);
  return isNaN(n) ? null : n;
}

/**
 * Formats a sensor value with its unit for display.
 * Reads unit_of_measurement from HA attributes, falls back to SENSOR_UNITS.
 */
function formatSensor(hass, entityId, key) {
  const s = getState(hass, entityId);
  if (!s) return '—';
  const val = parseFloat(s.state);
  if (isNaN(val)) return s.state;
  const unit = s.attributes?.unit_of_measurement ?? SENSOR_UNITS[key] ?? '';
  const decimals = key === 'illuminance' ? 0 : 1;
  return unit ? `${val.toFixed(decimals)} ${unit}` : val.toFixed(decimals);
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — SCHEDULE ENTITY PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses a Planta schedule entity into a normalised { isDue, label } object.
 *
 * Supports all entity types the Planta integration may expose:
 *
 *   binary_sensor   — state "on"  → due
 *   sensor (number) — state <= 0 → due; e.g. "0", "-1", "3" (days until care)
 *   sensor (date)   — "YYYY-MM-DD" <= today → due
 *   sensor (datetime) — ISO-8601 datetime <= now → due
 *
 * Returns: { isDue: boolean, label: string | null }
 */
function parseScheduleEntity(hass, entityId) {
  if (!entityId) return { isDue: false, label: null };

  const stateObj = getState(hass, entityId);
  if (!stateObj) return { isDue: false, label: null };

  const domain = entityId.split('.')[0];
  const raw    = stateObj.state;

  // ── binary_sensor ─────────────────────────────────────────────────────────
  if (domain === 'binary_sensor') {
    const due = raw === 'on';
    return { isDue: due, label: due ? 'Due now' : 'Not due' };
  }

  // ── numeric "days until" sensor ───────────────────────────────────────────
  // Check this before date parsing: "0" and "3" are valid numbers but are
  // also technically valid partial date strings in some JS engines.
  const numeric = parseFloat(raw);
  if (!isNaN(numeric) && String(parseFloat(raw)) === raw.trim()) {
    if (numeric <= 0)  return { isDue: true,  label: 'Due now'       };
    if (numeric === 1) return { isDue: false, label: 'Tomorrow'       };
    return { isDue: false, label: `In ${Math.round(numeric)} days` };
  }

  // ── date / datetime sensor ────────────────────────────────────────────────
  // Explicit handling of "YYYY-MM-DD" to avoid UTC-vs-local ambiguity:
  // new Date("2025-04-01") parses as midnight UTC, which is the previous day
  // in negative-offset timezones. Appending T00:00:00 forces local midnight.
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
  const parsed = new Date(isDateOnly ? raw.trim() + 'T00:00:00' : raw);

  if (!isNaN(parsed.getTime())) {
    const now    = new Date();
    const isDue  = parsed <= now;
    if (isDue) {
      const overdueDays = Math.floor((now - parsed) / 86400000);
      const label = overdueDays === 0 ? 'Due today'
                  : overdueDays === 1 ? 'Overdue 1 day'
                  : `Overdue ${overdueDays} days`;
      return { isDue: true, label };
    }
    const diffDays = Math.ceil((parsed - now) / 86400000);
    const label = diffDays === 1
      ? 'Tomorrow'
      : diffDays <= 7
        ? `In ${diffDays} days`
        : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return { isDue: false, label };
  }

  // Fallback: show raw state as label
  return { isDue: false, label: raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — CARE STATE RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the smart care state for every action type.
 *
 * Returns an object keyed by action key, each containing:
 *   {
 *     status:         STATUS.*,
 *     label:          string,      // button label
 *     scheduleLabel:  string|null, // secondary line (schedule info / reason)
 *     buttonDisabled: boolean,
 *     buttonPulsing:  boolean,     // urgent water only
 *   }
 */
function resolveCareStates(hass, config) {
  const thresholds  = config.thresholds ?? {};
  const moistureMin = thresholds.moisture_min ?? null;
  const moistureMax = thresholds.moisture_max ?? null;
  const moistureVal = numericState(hass, config.sensors?.moisture);

  const result = {};

  for (const def of CARE_ACTIONS) {
    const { key } = def;
    const schedule = parseScheduleEntity(hass, config.schedule?.[key]);

    if (key === 'water') {
      // ── Smart moisture-aware water logic ───────────────────────────────────

      if (moistureVal !== null && moistureMin !== null && moistureVal < moistureMin) {
        // Soil is too dry — urgent regardless of schedule
        result.water = {
          status:        STATUS.URGENT,
          label:         'Water Now',
          scheduleLabel: `Soil ${moistureVal.toFixed(0)}% — below min (${moistureMin}%)`,
          buttonDisabled: false,
          buttonPulsing:  true,
        };
        continue;
      }

      if (moistureVal !== null && moistureMax !== null && moistureVal > moistureMax) {
        // Soil is saturated — skip even if schedule says water
        const scheduled = schedule.isDue ? ' (scheduled)' : '';
        result.water = {
          status:        STATUS.SKIP,
          label:         'Watering Skipped',
          scheduleLabel: `Soil ${moistureVal.toFixed(0)}% — above max (${moistureMax}%)${scheduled}`,
          buttonDisabled: true,
          buttonPulsing:  false,
        };
        continue;
      }

      // Moisture is in range (or unknown) — fall through to schedule
      if (schedule.isDue) {
        result.water = {
          status:        STATUS.DUE,
          label:         'Water',
          scheduleLabel: schedule.label,
          buttonDisabled: false,
          buttonPulsing:  false,
        };
      } else {
        result.water = {
          status:        STATUS.AVAILABLE,
          label:         'Water',
          scheduleLabel: schedule.label,
          buttonDisabled: false,
          buttonPulsing:  false,
        };
      }
    } else {
      // ── Pure schedule-based logic (mist / fertilize / repot) ──────────────
      result[key] = {
        status:        schedule.isDue ? STATUS.DUE : STATUS.AVAILABLE,
        label:         capitalize(key),
        scheduleLabel: schedule.label,
        buttonDisabled: false,
        buttonPulsing:  false,
      };
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — CSS
// ─────────────────────────────────────────────────────────────────────────────

function buildCSS() {
  return `
    <style>
      :host { display: block; }

      ha-card {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
      }

      /* ── Header ──────────────────────────────────────────────────────────── */
      .plant-header {
        position: relative;
        min-height: 120px;
        background: var(--secondary-background-color);
        overflow: hidden;
        flex-shrink: 0;
      }
      .plant-header img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
        display: block;
        min-height: 120px;
        max-height: 200px;
      }
      .plant-name-overlay {
        position: absolute;
        bottom: 0; left: 0; right: 0;
        padding: 20px 14px 10px;
        background: linear-gradient(transparent, rgba(0,0,0,0.6));
        color: #ffffff;
        font-size: 1.15em;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      .plant-name-text {
        padding: 14px 16px 4px;
        font-size: 1.15em;
        font-weight: 500;
        color: var(--primary-text-color);
      }

      /* ── Sensors section ─────────────────────────────────────────────────── */
      .sensors-section {
        padding: 10px 16px 6px;
      }

      /* Moisture — full-width progress bar */
      .moisture-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }
      .moisture-label {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.75em;
        color: var(--secondary-text-color);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
        width: 78px;
        flex-shrink: 0;
      }
      .moisture-label ha-icon {
        --mdc-icon-size: 14px;
      }
      .moisture-bar-wrap {
        flex: 1;
        position: relative;
        height: 10px;
        border-radius: 5px;
        background: var(--secondary-background-color, rgba(0,0,0,0.08));
        overflow: visible;
      }
      .moisture-bar-fill {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        border-radius: 5px;
        transition: width 0.45s ease, background 0.3s ease;
        min-width: 4px;
      }
      /* Threshold tick marks */
      .moisture-tick {
        position: absolute;
        top: -3px;
        width: 2px;
        height: 16px;
        border-radius: 1px;
        transform: translateX(-50%);
      }
      .tick-min { background: var(--warning-color, #ffa600); }
      .tick-max { background: var(--error-color, #db4437);   }
      .moisture-value {
        font-size: 0.85em;
        font-weight: 600;
        width: 42px;
        text-align: right;
        flex-shrink: 0;
      }

      /* Other sensors — chip grid */
      .sensor-chips {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
        gap: 6px;
        margin-bottom: 6px;
      }
      .sensor-chip {
        display: flex;
        flex-direction: column;
        align-items: center;
        background: var(--secondary-background-color, rgba(0,0,0,0.04));
        border-radius: 10px;
        padding: 6px 4px 5px;
        gap: 2px;
      }
      .chip-icon {
        --mdc-icon-size: 16px;
        color: var(--secondary-text-color);
      }
      .chip-value {
        font-size: 0.82em;
        font-weight: 600;
        color: var(--primary-text-color);
        white-space: nowrap;
      }
      .chip-label {
        font-size: 0.62em;
        color: var(--secondary-text-color);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      /* ── Divider ─────────────────────────────────────────────────────────── */
      .divider {
        height: 1px;
        background: var(--divider-color, rgba(0,0,0,0.12));
        margin: 6px 0 2px;
      }

      /* ── Care actions ────────────────────────────────────────────────────── */
      .actions-section {
        padding: 10px 14px 14px;
      }
      .actions-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .action-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        padding: 10px 6px 8px;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.25s, opacity 0.2s, transform 0.1s, box-shadow 0.2s;
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
        color: var(--primary-text-color);
        text-align: center;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .action-btn:active:not([disabled]) {
        transform: scale(0.95);
      }
      .action-btn[disabled] {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .btn-icon {
        --mdc-icon-size: 22px;
      }
      .btn-label {
        font-size: 0.76em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        line-height: 1.2;
      }
      .btn-schedule {
        font-size: 0.68em;
        font-weight: 400;
        line-height: 1.2;
        color: inherit;
        opacity: 0.8;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Status modifiers */
      .action-btn.urgent {
        background: var(--error-color, #db4437);
        color: #ffffff;
      }
      .action-btn.due {
        background: var(--warning-color, #ffa600);
        color: #ffffff;
      }
      .action-btn.skip {
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
        color: var(--secondary-text-color);
      }
      .action-btn.skip .btn-label {
        text-decoration: line-through;
        opacity: 0.7;
      }
      .action-btn.available {
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
        color: var(--primary-text-color);
      }

      /* Pulsing glow for urgent water button */
      @keyframes pulse-urgent {
        0%,100% { box-shadow: 0 0 0 0   rgba(219, 68, 55, 0.5); }
        50%      { box-shadow: 0 0 0 8px rgba(219, 68, 55, 0);   }
      }
      .action-btn.urgent.pulsing {
        animation: pulse-urgent 1.8s ease-in-out infinite;
      }
    </style>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — HTML BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the colour for the moisture bar fill based on current value
 * relative to configured thresholds.
 */
function getMoistureBarColor(val, thresholds) {
  if (val === null) return 'var(--secondary-text-color)';
  const min = thresholds?.moisture_min ?? null;
  const max = thresholds?.moisture_max ?? null;
  if (min !== null && val < min) return 'var(--error-color, #db4437)';
  if (max !== null && val > max) return 'var(--warning-color, #ffa600)';
  return 'var(--success-color, #43a047)';
}

function buildHeader(config) {
  if (config.image) {
    return `
      <div class="plant-header">
        <img src="${config.image}" alt="${config.name}" loading="lazy">
        <div class="plant-name-overlay">${config.name}</div>
      </div>`;
  }
  return `<div class="plant-name-text">${config.name}</div>`;
}

function buildSensorsSection(hass, config) {
  const sensors    = config.sensors ?? {};
  const thresholds = config.thresholds ?? {};

  // ── Moisture bar ─────────────────────────────────────────────────────────
  let moistureHtml = '';
  if (sensors.moisture) {
    const val    = numericState(hass, sensors.moisture);
    const pct    = val !== null ? Math.min(100, Math.max(0, val)) : 0;
    const color  = getMoistureBarColor(val, thresholds);
    const valStr = val !== null ? `${val.toFixed(0)}%` : '—';
    const min    = thresholds.moisture_min;
    const max    = thresholds.moisture_max;

    const tickMin = (min != null)
      ? `<div class="moisture-tick tick-min" style="left:${min}%"></div>` : '';
    const tickMax = (max != null)
      ? `<div class="moisture-tick tick-max" style="left:${max}%"></div>` : '';

    moistureHtml = `
      <div class="moisture-row">
        <span class="moisture-label">
          <ha-icon icon="mdi:water-percent"></ha-icon>Moisture
        </span>
        <div class="moisture-bar-wrap">
          <div class="moisture-bar-fill" data-sensor-bar="moisture"
               style="width:${pct}%;background:${color}"></div>
          ${tickMin}${tickMax}
        </div>
        <span class="moisture-value" data-sensor="moisture"
              style="color:${color}">${valStr}</span>
      </div>`;
  }

  // ── Other sensor chips ────────────────────────────────────────────────────
  const otherSensors = [
    { key: 'temperature',  icon: 'mdi:thermometer',    label: 'Temp'      },
    { key: 'illuminance',  icon: 'mdi:weather-sunny',  label: 'Light'     },
    { key: 'conductivity', icon: 'mdi:lightning-bolt', label: 'Nutrients' },
  ];

  const chips = otherSensors
    .filter(s => sensors[s.key])
    .map(s => `
      <div class="sensor-chip">
        <ha-icon class="chip-icon" icon="${s.icon}"></ha-icon>
        <span class="chip-value" data-sensor="${s.key}">
          ${formatSensor(hass, sensors[s.key], s.key)}
        </span>
        <span class="chip-label">${s.label}</span>
      </div>`)
    .join('');

  const chipsHtml = chips ? `<div class="sensor-chips">${chips}</div>` : '';

  if (!moistureHtml && !chipsHtml) return '';

  return `
    <div class="sensors-section">
      ${moistureHtml}
      ${chipsHtml}
    </div>`;
}

function buildActionsSection(hass, config, careStates) {
  // Only render actions that have at least one of: schedule entity OR action entity
  const visibleActions = CARE_ACTIONS.filter(def => {
    return config.schedule?.[def.key] || config.actions?.[def.key];
  });

  if (visibleActions.length === 0) return '';

  const buttons = visibleActions.map(def => {
    const cs         = careStates[def.key];
    const entityId   = config.actions?.[def.key] ?? '';
    const disabled   = cs.buttonDisabled || !entityId ? 'disabled' : '';
    const pulseClass = cs.buttonPulsing ? ' pulsing' : '';

    return `
      <button class="action-btn ${cs.status}${pulseClass}"
              data-action="${def.key}"
              data-entity="${entityId}"
              ${disabled}>
        <ha-icon class="btn-icon" icon="${def.icon}"></ha-icon>
        <span class="btn-label">${cs.label}</span>
        <span class="btn-schedule">${cs.scheduleLabel ?? ''}</span>
      </button>`;
  }).join('');

  return `
    <div class="actions-section">
      <div class="actions-grid">${buttons}</div>
    </div>`;
}

function buildHTML(hass, config, careStates) {
  const hasSensors = Object.values(config.sensors ?? {}).some(Boolean);
  const divider    = hasSensors ? '<div class="divider"></div>' : '';

  return `
    <ha-card>
      ${buildHeader(config)}
      ${buildSensorsSection(hass, config)}
      ${divider}
      ${buildActionsSection(hass, config, careStates)}
    </ha-card>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — CUSTOM ELEMENT CLASS
// ─────────────────────────────────────────────────────────────────────────────

class PlantCareCard extends HTMLElement {

  // ── Static helpers (card picker registration) ─────────────────────────────

  static getStubConfig() {
    return {
      name: 'My Plant',
      image: '',
      sensors: {
        moisture:     '',
        temperature:  '',
        illuminance:  '',
        conductivity: '',
      },
      schedule: {
        water:     '',
        mist:      '',
        fertilize: '',
        repot:     '',
      },
      actions: {
        water:     '',
        mist:      '',
        fertilize: '',
        repot:     '',
      },
      thresholds: {
        moisture_min: 20,
        moisture_max: 60,
      },
    };
  }

  // ── Web Component lifecycle ───────────────────────────────────────────────

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config      = null;
    this._hass        = null;
    this._builtOnce   = false; // true after first full render
    this._raf         = null;  // requestAnimationFrame handle
  }

  // ── HA-required interface ─────────────────────────────────────────────────

  setConfig(config) {
    if (!config.name) {
      throw new Error('plant-care-card: "name" is required');
    }
    this._config    = { thresholds: { moisture_min: 20, moisture_max: 60 }, ...config };
    this._builtOnce = false; // force full rebuild on config change
    this._scheduleRender();
  }

  set hass(hass) {
    this._hass = hass;
    this._scheduleRender();
  }

  getCardSize() {
    // Rough estimate for HA layout engine
    let size = 2; // actions grid
    if (this._config?.image)           size += 2;
    if (this._config?.sensors?.moisture) size += 1;
    return size;
  }

  // ── Render orchestration ──────────────────────────────────────────────────

  /**
   * Debounces render calls via requestAnimationFrame to avoid redundant work
   * when both setConfig and hass are set in the same tick.
   */
  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this._render();
    });
  }

  _render() {
    if (!this._config || !this._hass) return;

    const careStates = resolveCareStates(this._hass, this._config);

    if (!this._builtOnce) {
      this._fullRender(careStates);
      this._builtOnce = true;
    } else {
      this._patchRender(careStates);
    }
  }

  /**
   * Full render: rewrites the entire shadow root.
   * Called once on initial load and whenever setConfig fires.
   * Attaches event listeners after building the DOM.
   */
  _fullRender(careStates) {
    this.shadowRoot.innerHTML =
      buildCSS() + buildHTML(this._hass, this._config, careStates);
    this._attachListeners();
  }

  /**
   * Patch render: surgically updates only the dynamic parts of the DOM.
   * Called on every hass state tick. Never recreates DOM nodes so that
   * event listeners (attached once after _fullRender) are preserved.
   *
   * Updates:
   *   - Sensor chip values
   *   - Moisture bar width + colour + value text
   *   - Action button classes, disabled state, pulsing, and label text
   */
  _patchRender(careStates) {
    const root   = this.shadowRoot;
    const hass   = this._hass;
    const config = this._config;
    const sensors = config.sensors ?? {};

    // ── Sensor chips ─────────────────────────────────────────────────────────
    for (const key of ['temperature', 'illuminance', 'conductivity']) {
      const el = root.querySelector(`[data-sensor="${key}"]`);
      if (el) el.textContent = formatSensor(hass, sensors[key], key);
    }

    // ── Moisture bar ──────────────────────────────────────────────────────────
    if (sensors.moisture) {
      const val   = numericState(hass, sensors.moisture);
      const pct   = val !== null ? Math.min(100, Math.max(0, val)) : 0;
      const color = getMoistureBarColor(val, config.thresholds);

      const fill = root.querySelector('[data-sensor-bar="moisture"]');
      if (fill) { fill.style.width = `${pct}%`; fill.style.background = color; }

      const text = root.querySelector('[data-sensor="moisture"]');
      if (text) {
        text.textContent  = val !== null ? `${val.toFixed(0)}%` : '—';
        text.style.color  = color;
      }
    }

    // ── Action buttons ────────────────────────────────────────────────────────
    for (const def of CARE_ACTIONS) {
      const btn = root.querySelector(`[data-action="${def.key}"]`);
      if (!btn) continue;

      const cs          = careStates[def.key];
      const entityId    = config.actions?.[def.key] ?? '';
      const isDisabled  = cs.buttonDisabled || !entityId;
      const pulseClass  = cs.buttonPulsing ? ' pulsing' : '';

      btn.className       = `action-btn ${cs.status}${pulseClass}`;
      btn.disabled        = isDisabled;

      const labelEl    = btn.querySelector('.btn-label');
      const scheduleEl = btn.querySelector('.btn-schedule');
      if (labelEl)    labelEl.textContent    = cs.label;
      if (scheduleEl) scheduleEl.textContent = cs.scheduleLabel ?? '';
    }
  }

  /**
   * Attaches click handlers to all action buttons.
   * Must be called after a full render. Event listeners survive patch renders.
   */
  _attachListeners() {
    for (const def of CARE_ACTIONS) {
      const btn = this.shadowRoot.querySelector(`[data-action="${def.key}"]`);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const entityId = btn.dataset.entity;
        if (!entityId || !this._hass) return;
        this._hass.callService('button', 'press', { entity_id: entityId });
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

customElements.define('plant-care-card', PlantCareCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        'plant-care-card',
  name:        'Plant Care Card',
  description: 'Displays Miflora/Zigbee sensor data alongside Planta integration care schedules and action buttons, with smart moisture-aware watering logic.',
  preview:     true,
});

console.info(
  `%c PLANT-CARE-CARD %c v${CARD_VERSION} `,
  'background:#4CAF50;color:white;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px;',
  'background:#2196F3;color:white;font-weight:bold;padding:2px 4px;border-radius:0 3px 3px 0;',
);
