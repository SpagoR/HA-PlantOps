# HA-PlantOps — Plant Care Card

A custom [Home Assistant](https://www.home-assistant.io/) Lovelace card for plant care management.

Combines **Miflora / Zigbee sensor readings** with **[Planta integration](https://github.com/natekspencer/ha-planta) care schedules and action buttons**, applying smart logic so buttons stay silent when the soil says everything is fine — and pulse red when you actually need to water.

---

## Features

- **Sensor display** — soil moisture (progress bar with threshold markers), temperature, light (lux), and conductivity/nutrients
- **Care schedule** — water, mist, fertilize, repot — reads Planta's schedule entities and shows due dates in plain language
- **Action buttons** — one tap calls `button.press` on the configured Planta action entity
- **Smart watering logic** — four distinct states driven by live moisture vs. configured thresholds (see below)
- **Automatic theming** — uses HA CSS custom properties; works correctly in both light and dark mode
- **No build step** — single vanilla JS file, no bundler or Node.js required

---

## Installation

### Option A — HACS (recommended)

1. Open HACS → **Frontend**
2. Click the three-dot menu → **Custom repositories**
3. Add `https://github.com/YOUR_USER/HA-PlantOps` with category **Dashboard**
4. Install **Plant Care Card**
5. Hard-refresh the browser (Ctrl+Shift+R)

### Option B — Manual

1. Copy `plant-care-card.js` to `/config/www/plant-care-card.js`
2. In HA: **Settings → Dashboards → Resources** (or edit `ui-lovelace.yaml`)
3. Add the resource:

```yaml
resources:
  - url: /local/plant-care-card.js
    type: module
```

4. Hard-refresh the browser

---

## Configuration

Add a card with type `custom:plant-care-card`. All sub-sections are optional — configure only what you have.

```yaml
type: custom:plant-care-card

# Required
name: "Monstera Deliciosa"

# Optional plant photo (local path or external URL)
image: /local/plants/monstera.jpg

# Sensor entities — any combination, all optional
sensors:
  moisture:     sensor.monstera_moisture        # soil moisture %
  temperature:  sensor.monstera_temperature     # °C (or °F, shows HA unit)
  illuminance:  sensor.monstera_illuminance      # lux
  conductivity: sensor.monstera_conductivity     # µS/cm

# Care schedule entities from Planta (see "Schedule entity types" below)
schedule:
  water:     sensor.monstera_next_watering
  mist:      sensor.monstera_next_misting
  fertilize: sensor.monstera_next_fertilizing
  repot:     sensor.monstera_next_repotting

# Planta action button entities
actions:
  water:     button.monstera_water
  mist:      button.monstera_mist
  fertilize: button.monstera_fertilize
  repot:     button.monstera_repot

# Moisture thresholds for smart watering logic (defaults shown)
thresholds:
  moisture_min: 20   # below this → URGENT regardless of schedule
  moisture_max: 60   # above this → SKIP even if schedule is due
```

### Minimal example (schedule + actions only, no sensors)

```yaml
type: custom:plant-care-card
name: "Pothos"
schedule:
  water: sensor.pothos_next_watering
actions:
  water: button.pothos_water
```

---

## Finding your entity IDs

Open **Developer Tools → States** in HA and filter by your plant's name. Planta entities typically follow patterns like:

| What you need | Likely entity pattern |
|---|---|
| Moisture sensor | `sensor.<plant>_moisture` |
| Next watering date | `sensor.<plant>_next_watering` |
| Water action | `button.<plant>_water` |

Entity names vary by integration version — use the States panel to confirm exact IDs.

---

## Schedule entity types

The card auto-detects which format Planta uses for schedule entities:

| Entity type | Example state | Interpretation |
|---|---|---|
| `binary_sensor` | `on` | Due now |
| `sensor` (numeric days) | `0`, `3`, `14` | 0 = due now, N = in N days |
| `sensor` (date) | `2025-04-03` | Date <= today = due |
| `sensor` (datetime) | `2025-04-03T08:00:00` | Datetime <= now = due |

---

## Smart watering logic

The four possible states for the **Water** button:

| State | Condition | Button appearance |
|---|---|---|
| **URGENT** | `moisture < moisture_min` (ignores schedule) | Red, pulsing glow, always enabled |
| **SKIP** | `moisture > moisture_max` (ignores schedule) | Greyed out, disabled, shows reason |
| **DUE** | Moisture in range AND schedule is due | Amber, enabled |
| **AVAILABLE** | Moisture in range AND schedule not due | Neutral, enabled for manual use |

When moisture data is unavailable, the card falls back to the schedule alone (treats it as if moisture is in range).

Mist, fertilize, and repot buttons are purely schedule-driven and are never suppressed by sensor data.

---

## Threshold tick marks

The moisture bar displays two thin vertical tick marks:

- **Amber tick** — `moisture_min` (below this = too dry)
- **Red tick** — `moisture_max` (above this = too wet)

The bar fill colour matches the current state: green (good), red (too dry), amber (too wet).

---

## Troubleshooting

**Button does nothing** — confirm the entity in `actions:` is a `button.*` entity and that HA can call `button.press` on it manually via Developer Tools → Services.

**Schedule shows `—`** — the schedule entity is unavailable or not configured. Check the entity ID in Developer Tools → States.

**Card not appearing in card picker** — hard-refresh the browser (Ctrl+Shift+R) after adding the resource. Check the browser console for errors.

**Moisture bar missing** — `sensors.moisture` is not configured or the sensor entity is unavailable. Verify the entity ID.
