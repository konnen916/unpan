<div align="center">

# unpan

**Fix records that were mixed with the drums in one ear.**

Runs in your browser. Nothing is uploaded anywhere.

</div>

---

I was listening to Cinema Olympia by Elis Regina and the vocals and drums were
entirely in the left channel while everything else sat in the right. That is not
a fault in the file. It is how records were mixed before engineers trusted
stereo, and it is fine on speakers and unbearable on headphones.

Collapsing it all the way to mono fixes the problem and flattens the record.
What you usually want is somewhere in between.

## What it does

Drag in a file, drag the width slider, hear it move. Then download the result if
you want to keep it.

The whole thing is one 2x2 matrix:

    mid  = (L + R) / 2
    side = (L - R) / 2
    L'   = mid + w * side
    R'   = mid - w * side

At `w = 1` nothing changes. At `w = 0` both channels become the average, which
is mono. Everything between is a dial.

**Width cannot go above 1, and that is what makes clipping impossible.** Expand
that matrix and each output is a convex combination of the two inputs, so it can
never exceed the peak that was already there. It is a property of the
arithmetic, not a check that runs afterwards. Widening would break it, which is
why it is not offered.

## Channel correlation

The number at the top is the correlation between the two channels, from `-1` to
`+1`.

| Reading | Meaning |
|---|---|
| `+1` | The channels are identical. Already mono. |
| `0` | They share nothing. This is the hard panned mix. |
| `-1` | One is the other inverted. Summing them would cancel to silence. |

Cinema Olympia reads near zero, and the needle walks toward `+1` as you pull the
width down. That one number explains the whole problem to somebody who has never
thought about it, which is why it is on screen rather than buried in a menu.

## On quality

Export is WAV, either 24 bit with dither or 32 bit float, at the rate the file
was decoded at.

**Nothing here can add quality that was never in the file.** If you load a 320
kbps MP3, the decoded audio is all there is, and re-encoding it to MP3 would
lose more. So the only honest export is one that takes nothing further away,
which is what a lossless container does.

One real caveat, stated on the page as well: `decodeAudioData` resamples to
whatever rate your audio device runs at. For WAV files unpan reads the rate out
of the header first and builds the audio context to match, so nothing is
resampled. For compressed formats there is no cheap way to know the original
rate, so it tells you what it actually decoded at rather than implying the
original survived.

## Running it

It is three files and no build step.

```bash
git clone https://github.com/konnen916/unpan
cd unpan
python3 -m http.server 8000
```

Then open `http://localhost:8000`. It has to be served rather than opened as a
file, because it uses ES modules.

## Tests

The arithmetic lives in `audio.js` with no browser APIs in it, so it runs under
Node:

```bash
node --test tests/
```

The one worth reading generates five hundred random stereo buffers at random
widths and asserts the output never exceeds the input peak. That is the
no-clipping claim, checked as a property rather than on a couple of examples.

## License

MIT.
