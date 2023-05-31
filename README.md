# bsd-copy-paste
Chrome extension to provide copy>paste for BSD teachers from canvas to synergy. See [This youtube demo](https://youtu.be/ZI-WODo4dOI).

This extension uses the Canvas API to fetch outcome_rollups, assignments, submissions and students from canvas. The extension uses the student data to match student's canvas user_id with their synergy student_id and update all submissions results to include their synergy_id. Submissions results consist of the set of available outcome scores for each student on a given assignment.

Once Canvas data is fetched it is updated and sent to service_worker (background.js) which requests the creation of a contextMenu available when the user clicks into a cell in Synergy gradebook. The context menu allows the user to choose the Academic Learning Target (ALT) from which to enter scores. The 'paste' function ensures a match between the synergy_id's. Unmatched scores on either side will have no effect on the paste.

# Active Development

1. Changes to support docs
2. Testing app in real gradebook environments

# Changelog
v1.102 adds raw-score paste functionality.

v1.101 provides link to Options from bottom of popup

v1.10 implements overall outcome copy-paste and also provides Options menu (right click extension icon in toolbar > Options) which allows a change of default rounding. Accepted on chrome store as of April 16th, 2023. Focus on making extension more responsive (testing for listeners before initializing to prevent multiple listener issue) and fixing issues that result from periods of inactivity (causes service_worker to go unresponsive)
Make design changes that improve consistency across app