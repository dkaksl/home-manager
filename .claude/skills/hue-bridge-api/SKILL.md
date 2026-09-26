---
name: hue-bridge-api
description: Talk to the home Philips Hue bridge (BSB002) directly over its local v1 and v2 (CLIP) REST APIs — read lights, rooms, zones, scenes, sensors and switch configurations, change light state, recall scenes, and safely rewrite/restore what a Hue dimmer switch does. Use when debugging home-manager's scheduler against live bridge state, exploring what the bridge exposes, or doing a one-off change to lights or switches without going through the home-manager app.
---

# Using the Hue bridge API

Verified 2026-09-26 against the home bridge (BSB002, swversion 1978293000,
API 1.78.0). Everything is on the LAN, with no cloud account involved.

## Credentials

```bash
set -a; . /home/amani/vcs/github/.env.hue; set +a   # HUE_IP, HUE_USER
```

In a clone of only `home-manager`, the same two variables are in
`home-manager/.env`. `HUE_USER` is the bridge "application key". It works for
both API versions. Never print it or commit it.

```bash
V1="http://$HUE_IP/api/$HUE_USER"
V2="https://$HUE_IP/clip/v2/resource"
H="hue-application-key: $HUE_USER"
curl -s  "$V1/lights"
curl -sk -H "$H" "$V2/light"     # -k: the bridge's cert is self-signed
```

## v1 vs v2: which to use

| | v1 (`http://…/api/<key>/…`) | v2 (`https://…/clip/v2/resource/…`) |
|---|---|---|
| Ids | small numbers (`"3"`) | UUIDs |
| Auth | key in the URL path | `hue-application-key` header |
| Response | object keyed by id | `{"errors": [...], "data": [...]}` |
| Needed for | quick light/group state, classic scenes, raw sensors | smart scenes, **switch button mappings** (`behavior_instance`), devices, anything the modern Hue app configures |

home-manager uses v1 ids everywhere. To map between the two, every v2 resource
has `id_v1`, e.g. a v2 `room` with `"id_v1": "/groups/1"`, or a v2 `device`
with `"id_v1": "/sensors/2"`. Match on that, not on names.

A bad v1 key gives `[{"error":{"type":1,...}}]` with HTTP 200. v2 errors come
back in `errors[]`. **Always check `errors`, even on HTTP 200**, because a
rejected v2 write can still return 200 with the resource unchanged.

## What's on this bridge

`curl -sk -H "$H" "$V2" | jq -r '.data|group_by(.type)[]|"\(.[0].type): \(length)"'`
lists every resource type with its count. As of the verification date:

- **Rooms (v1 group id → name):** 1 Nere, 3 Kontoret, 5 Bakgård, 6 Sovrummet,
  7 Trapporna, 82 Lekrummet. **Zones:** 2 Matbord, 4 Vardagsrum (subset of
  Nere), 81 Maishas skrivbord. **Entertainment:** 200 Spel PC.
- **Switches:** three Hue dimmer switches (RWL022). They are v1 sensors
  2/5/8, named "Hue dimmer nere/kontoret/sovrummet", and are bound to rooms
  1/3/6. **Rooms 5, 7 and 82 have no switch.**
- v1 `/rules` holds 11 "Dimmer switch N tgl-press/hue-press" rules plus
  `CLIPGenericStatus` helper sensors. They are **leftovers from the old Hue app**:
  the toggle helpers haven't changed since 2023, and the `behavior_instance`s
  say `"migrated_from": "/resourcelinks/…"`. They do not decide what a
  button press does.

Re-check these with the recipes below before relying on them.

## Recipes

**Inventory (v1):**
```bash
curl -s $V1/groups  | jq -c 'to_entries[]|{id:.key,name:.value.name,type:.value.type,lights:.value.lights,sensors:.value.sensors}'
curl -s $V1/sensors | jq -c 'to_entries[]|{id:.key,name:.value.name,type:.value.type,state:.value.state}'
```

**Light / room state (v1):**
```bash
curl -s -X PUT -d '{"on":true,"bri":200,"ct":350}' $V1/lights/13/state
curl -s -X PUT -d '{"on":false}'                   $V1/groups/3/action
curl -s -X PUT -d '{"scene":"<v1 scene id>"}'      $V1/groups/3/action
```
`bri` is 1–254 and `ct` is in mireds, clamped to each bulb's
`capabilities.control.ct` range. The bridge rounds `ct` on readback.

**Scenes:** v1 `GET /scenes` omits per-light targets. Only
`GET /scenes/<id>` includes `lightstates`. Smart scenes (they cycle scenes
through the day) exist only in v2. Recall one with
`PUT $V2/smart_scene/<id> {"recall":{"action":"activate"}}`. Re-activating
one restarts its cycle.

**Room/device lookups (v2):**
```bash
curl -sk -H "$H" $V2/room   | jq -c '.data[]|{id,name:.metadata.name,id_v1}'
curl -sk -H "$H" $V2/device | jq -c '.data[]|select(any(.services[];.rtype=="button"))|{id,name:.metadata.name,id_v1}'
```

## Switch button mappings (`behavior_instance`)

What a dimmer does is a v2 `behavior_instance` running the
"Generic switches script" (`script_id 67d9395b-…`), one per switch:

```bash
curl -sk -H "$H" $V2/behavior_instance | jq -c '.data[]|select(.configuration.buttons)|{id,name:.metadata.name}'
```

`configuration.buttons` maps each v2 `button` id to its handlers and target:

```jsonc
"<button id>": {
  "on_short_release": { "time_based_extended": { ...slots of scene recalls... } },
  "on_long_press":    { "action": "do_nothing" },
  "where": [{ "group": { "rid": "<v2 room id>", "rtype": "room" } }]
}
"<dim button id>": { "on_repeat": { "action": "dim_up" }, "where": [...] }
```

Findings from testing on the Kontoret dimmer:

- **`PUT {"enabled": false}` does not work** on switch instances. The bridge
  answers `"The instance doesn't support triggers."` and leaves `enabled`
  `true`. (It does work for automations like "Rise and Shine".)
- **`PUT {"configuration": {...}}` works**, and writing a saved configuration
  back gives a byte-identical instance (same id, dependees and
  `migrated_from`). This is how to silence a switch and restore it later.
- The script's JSON schema accepts only certain handler combinations per
  button. To silence a button, **keep its handler keys and replace each value
  with `{"action":"do_nothing"}`**. Adding keys it didn't have (e.g.
  `on_repeat` next to `on_short_release`) is rejected with a large `oneOf`
  schema error, and the instance is left unchanged.

Safe pattern: **snapshot → write → read back → restore → diff**:

```bash
ID=<behavior_instance id>
curl -sk -H "$H" $V2/behavior_instance/$ID | jq -S '.data[0]' > before.json
jq '{configuration: (.configuration | .buttons |= map_values(with_entries(
      if .key == "where" then . else .value = {action:"do_nothing"} end)))}' before.json > silent.json
curl -sk -X PUT -H "$H" -H 'Content-Type: application/json' -d @silent.json $V2/behavior_instance/$ID
# ...later:
jq '{configuration}' before.json > restore.json
curl -sk -X PUT -H "$H" -H 'Content-Type: application/json' -d @restore.json $V2/behavior_instance/$ID
curl -sk -H "$H" $V2/behavior_instance/$ID | jq -S '.data[0]' | diff before.json - && echo identical
```

home-manager's kill switch does exactly this, per room, in
`server/switchLocks.ts`. Its originals are in `data/switch-locks.json`.
**Don't hand-edit a switch whose room has an active kill switch**, because
the app expects to restore it.

## Before writing anything

- These are real lights in an occupied house. Prefer reads. Snapshot anything
  before changing it, and restore it in the same session.
- home-manager's scheduler (on the Pi) ticks every minute and will fight
  manual light changes in rooms that have a schedule or kill switch. Check
  `home-manager/data/schedules.json` on the deployed host if a change "doesn't
  stick".
- Phone apps (Hue, HomeKit/Matter) can always change lights. Nothing on the
  bridge blocks them.
