# Dreamtide: Reverie of the Last Magus

A Vampire Survivors / Brotato–style auto-battler set inside a drowning dream.
All visuals are drawn in code (canvas), all sounds are synthesized with WebAudio — no assets.

## Run it
```
npm install
npm run dev
```
Then open the printed local URL.

## Play
- Move with **WASD / arrow keys**. Spells cast themselves.
- Collect essence gems to level up and choose from 7 spell schools
  (Pyromancy, Arcana, Cryomancy, Tempestry, Umbramancy, Verdancy, Lunamancy)
  plus passive boons.
- Elites spawn periodically; the Devourer boss rises every ~100 seconds.
- Difficulty scales continuously — enemy health, damage and spawn rate all grow with time.

## Tech
- React 18 + Vite, zustand for UI state
- Custom canvas engine: pooled particle system (~3600 particles),
  parallax dreamscape, screen shake, additive-blend spell VFX
- WebAudio synth: ambient drone pad + per-spell sound cues
