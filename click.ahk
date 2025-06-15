SetDefaultMouseSpeed 10

; Delay before moving to simulate human behavior
Random, delay, 300, 1000
Sleep, %delay%

; Electron window opens at x=0, y=0 and width=50% of screen
SysGet, ScreenWidth, 78
SysGet, ScreenHeight, 79

; Electron window is half the screen width, full height
windowWidth := ScreenWidth / 2
windowHeight := ScreenHeight

; Cloudflare checkbox estimated at 36% width, 38% height
clickX := Round(windowWidth * 0.33)
clickY := Round(windowHeight * 0.37)

; 🖱 Move to the checkbox and click
MouseMove, clickX, clickY, 20
Sleep, 600

;Click

; 👤 Simulate random human movement away
;Random, randX, 200, ScreenWidth
;Random, randY, 200, ScreenHeight
;MouseMove, randX, randY, 15
