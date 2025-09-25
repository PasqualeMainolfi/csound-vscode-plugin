<CsoundSynthesizer>
<CsOptions>
-odac -d
</CsOptions>
<CsInstruments>
sr = 44100
ksmps = 32
nchnls = 2
0dbfs = 1

instr 1
    ; Simple sine wave test
    aout oscili 0.1, 440
    outs aout, aout
endin
</CsInstruments>
<CsScore>
i1 0 2
</CsScore>
</CsoundSynthesizer>
