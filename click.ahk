SetDefaultMouseSpeed 10

; Random delay before move
Random, delay, 300, 1000
Sleep, %delay%

; Simulate slight mouse wiggle near checkbox
MouseMove, 465, 228, 20, R
Sleep, 300

; Move to checkbox and click
MouseMove, 135, 280
Sleep, 1000
Click

; 🧠 Move mouse to random location (simulate human moving away)
Random, randX, 200, 1200
Random, randY, 200, 700
MouseMove, %randX%, %randY%, 15
