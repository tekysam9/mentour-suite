// What counts as an acceptable NEW password (sign-up, joining, a login created by HR, changing a password).
// Length matters most; the other checks only catch the passwords attackers try first. Existing passwords still work.
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const BAD_WORDS = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'changeme', 'mentour', 'admin', 'login', 'secret', 'abc123', '123456', '111111', '000000', 'monkey', 'dragon', 'football', 'baseball'];

function runLength(s) { // longest run of characters going up or down by one (abcdef, 987654)
  let best = 1, up = 1, down = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = d === 1 ? up + 1 : 1; down = d === -1 ? down + 1 : 1;
    best = Math.max(best, up, down);
  }
  return best;
}

// Returns a plain-language reason the password is not allowed, or null when it is fine.
function check(password, who) {
  const p = String(password == null ? '' : password);
  if (p.length < MIN_LENGTH) return 'Use at least ' + MIN_LENGTH + ' characters. A few unrelated words (like “plum-harbor-clock-seven”) are easy to remember and hard to guess.';
  if (p.length > MAX_LENGTH) return 'That password is too long (most ' + MAX_LENGTH + ' characters).';
  const low = p.toLowerCase();
  const hit = BAD_WORDS.find((w) => low.includes(w));
  if (hit) return 'That password contains a very common word or pattern (“' + hit + '”). Pick something less guessable, or let your password manager generate one.';
  if (new Set(low).size < 6 || runLength(low) >= 6 || /(.)\1{4,}/.test(low)) return 'That password is too repetitive or predictable (like 111111 or abcdef). Pick something less guessable.';
  const email = String((who && who.email) || '').toLowerCase().split('@')[0];
  if (email.length >= 4 && low.includes(email)) return 'Your password should not contain your email name.';
  for (const t of String((who && who.name) || '').toLowerCase().split(/[^a-z]+/)) if (t.length >= 4 && low.includes(t)) return 'Your password should not contain your name.';
  return null;
}

module.exports = { check, MIN_LENGTH };
