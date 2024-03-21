# bsd-copy-paste
Chrome extension to provide copy>paste for BSD teachers from canvas to synergy. See [This youtube demo](https://youtu.be/ZI-WODo4dOI).

This extension uses the Canvas API to fetch outcome_rollups, assignments, submissions and students from canvas. The extension uses the student data to match student's canvas user_id with their synergy student_id and update all submissions results to include their synergy_id. Submissions results consist of the set of available outcome scores for each student on a given assignment.

Once Canvas data is fetched it is updated and sent to service_worker (background.js) which requests the creation of a contextMenu available when the user clicks into a cell in Synergy gradebook. The context menu allows the user to choose the Academic Learning Target (ALT) from which to enter scores. The 'paste' function ensures a match between the synergy_id's. Unmatched scores on either side will have no effect on the paste.

# Active Development

1. Changes to support docs
2. Testing app in real gradebook environments

# Changelog
v1.105 Brings back Options page and allows teachers to choose what to paste for **missing** Canvas assignments. On the **Options** screen you can select one of three choices for how to handle missing/zero scores from Canvas:
* Comment -- Erases existing mark and enters "Mi !ex"
* Score -- Enters either "N !ex" or "R !ex" 
* Skip -- Does not paste anything into the cell (if you fill down scores first the paste will ignore students with **missing** or **0** in Canvas)

v1.104 updates popup providing a table showing all rubric scores, points, missing, late, and excused values available for paste. This is intended to help teachers understand what will be pasted and speed up any troubleshooting if a paste does not go as intended. If the extension doesn't seem to be working for you this table might help with determining if properly formatted **rubric scores** exist for students on a given assignment in Canvas.

v1.103 updates handling of assignment status missing, late, excused. Fixes issues handling excused, and clearing existing comments and codes when no longer missing, excused or late.

v1.101 provides link to Options from bottom of popup

v1.10 implements overall outcome copy-paste and also provides Options menu (right click extension icon in toolbar > Options) which allows a change of default rounding. Accepted on chrome store as of April 16th, 2023. Focus on making extension more responsive (testing for listeners before initializing to prevent multiple listener issue) and fixing issues that result from periods of inactivity (causes service_worker to go unresponsive)
Make design changes that improve consistency across app