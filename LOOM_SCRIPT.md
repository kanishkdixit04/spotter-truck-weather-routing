# Loom walkthrough, about 7 minutes

Talk, don't read. These are notes for what to say and where to click, not lines to recite.

## 0:00 What this is (20 sec)

"This is a weather-aware routing app for trucks. You give it a trip and a load weight, it checks the forecast along three routes at the times the truck will really be there, and tells you which one is safest. React on the front, Django behind it."

## 0:20 The demo (2.5 min)

Open the site cold. Point out that it already shows a live sample trip, with no typing needed.

Click the Chicago to Denver example. Load 42k lb, check every 50 miles, breaks on. Press Compare routes.

- Read the verdict out loud: which route and why. The reason sentence names the rule that decided it.
- Click through the three route cards. Point at the ribbon: each cell is a checkpoint, coloured by risk, so you can see where along the road the weather gets bad.
- On the map, the selected route is coloured along its length. Click one of the dots for the ETA and weather there.
- Hover a row in the checkpoint table and show the point lighting up on the map.
- Mention that rest and break stops are already inside the ETAs.
- Show the pill at the top ("Good to go") and the Best time to leave bars. Click a bar and watch the trip replan for that departure.
- Show the official alerts line, then the "What if the load changes?" list if it appears.
- Share the trip, then open the print briefing.

## 2:20 The heatmap (1.5 min)

Press play, then drag the slider. Say what the bars above it are: the worst conditions anywhere on the corridor for each hour, so you can see the rough stretch coming.

Switch to Wind and let the wind streaks flow, then Rain, then Snow. Turn on Follow truck and press Space to play. Point out that the route colour, the dots and the ribbons change too, not just the overlay. Then switch the basemap to Satellite and back to show everything survives the change.

## 3:50 The logic (2 min)

Open `backend/routing/domain/risk.py`.

- The thresholds are from the brief. Explain the boundary choice: lower bounds are inclusive, and No Travel follows the table's own wording.
- Weather is read at arrival time, not departure time. The 10 hour rest is a good example, because it changes the forecast hour for everything after it.
- Open `ranking.py`: Severe, then High, then average risk, then time. Mention that I compare No Travel first, and why.
- Routing: three distinct routes, with duplicates and silly detours thrown out.

## 5:50 Speed (45 sec)

The heatmap is one small canvas that the GPU smooths, and the slider doesn't go through React state, so dragging stays at 60 fps. I measured the frame times, they are in the README.

## 6:35 Wrap up (25 sec)

35 backend tests, a README that explains the decisions, deployed on Vercel. Be honest about the limits: the Hours of Service rules are simplified, the public routing server has no truck restrictions, and it is forecast data, not live alerts.
