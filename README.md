# Evia's Word Summit

A spaced-repetition SSAT vocabulary trainer for Evia, hosted on GitHub Pages.

- **800 words in 16 decks** across three levels — Essential (10 decks), Intermediate (4), Advanced (2). The word list and level/deck structure follow the Manhattan Review SSAT flashcard organization; all definitions and example sentences are original to this project, written at a middle-school reading level.
- **Decks**: Evia starts decks when she's ready; new words are introduced a few per round with a preview card before being quizzed.
- **Practice**: 10-question rounds mixing four question types — pick the meaning, pick the word, fill in the blank (typing, with spelling tolerance), and letter-tile unscramble.
- **Scheduling**: Leitner boxes. Each correct first-try answer moves a word up a level with a longer rest (1, 3, 7, 14 days); a miss sends it back to level 1 and repeats it in the round. Review rounds mix all started decks.
- **Progress tab**: mastery/struggle summary, per-deck and per-word accuracy, session history, accuracy by question type.
- **Scores** sync via Supabase (with localStorage fallback), so progress is shared across devices.

Static files (`index.html` + `words.js`), no build step.

## Credits

Celebration clips are embedded from GIPHY's CDN rather than copied into this
repo. One is picked at random when a round ends, never repeating twice in a row.
When the treat jar passes a milestone, a drawn before→after card shows the
goldendoodle growing. If a clip cannot be reached, the app falls back to drawn
SVG art so the screen still works offline.

- https://giphy.com/gifs/star-puppy-goldendoodle-h7u14Y8Y9mMp3Fzqif
- https://giphy.com/gifs/mammamiacovers-dogs-puppy-goldendoodles-31MXTUNTICxiEt2BsG
- https://giphy.com/gifs/mixcynmatch-goldendoodmiso-JgReHQJPGaL3KKREbV
- https://giphy.com/gifs/goldendoodle-cockapoo-embarasseddog-cPzc5CjRHy4PZDjFgE
- https://giphy.com/gifs/puppy-sleep-mixcynmatch-1p9KNyGjKpICkLFcyZ
- https://giphy.com/gifs/dog-goldendoodle-mehercat-tKu0JvWPrOLJpBch4L
