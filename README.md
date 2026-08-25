# Evia's Word Summit

A spaced-repetition SSAT vocabulary trainer for Evia, hosted on GitHub Pages.

- **800 words in 16 decks** across three levels — Essential (10 decks), Intermediate (4), Advanced (2). The word list and level/deck structure follow the Manhattan Review SSAT flashcard organization; all definitions and example sentences are original to this project, written at a middle-school reading level.
- **Decks**: Evia starts decks when she's ready; new words are introduced a few per round with a preview card before being quizzed.
- **Practice**: 10-question rounds mixing four question types — pick the meaning, pick the word, fill in the blank (typing, with spelling tolerance), and letter-tile unscramble.
- **Scheduling**: Leitner boxes. Each correct first-try answer moves a word up a level with a longer rest (1, 3, 7, 14 days); a miss sends it back to level 1 and repeats it in the round. Review rounds mix all started decks.
- **Parent tab**: mastery/struggle summary, per-deck and per-word accuracy, session history, accuracy by question type.
- **Scores** sync via Supabase (with localStorage fallback), so progress is shared across devices.

Static files (`index.html` + `words.js`), no build step.
