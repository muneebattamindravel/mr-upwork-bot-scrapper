SetDefaultMouseSpeed 10, 

; Random delay
Random, delay, 300, 1000
Sleep, %delay%

; Simulate slight mouse wiggle
MouseMove, 465, 228, 20, R
Sleep, 300

; Move to target
MouseMove,135,280
Sleep, 1000
Click
