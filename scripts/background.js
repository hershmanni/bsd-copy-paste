// TODO
// update contextMenu persistence...



// function get_rubric_id_from_scores(scores) {
//     // assuming multiple scores
//     return scores[0].rubric_id
// }

async function getRoundingDecimal() {
    let p = new Promise((resolve, reject) => {
        chrome.storage.sync.get(
            keys = {
                roundUpFrom: 0.5
            },
            (items) => {
                chrome.runtime.lastError
                ? reject(Error(chrome.runtime.lastError.message))
                : resolve (items.roundUpFrom)
            }
        )
    })
    return p
}

async function getMissingPref() {
    let p = new Promise((resolve, reject) => {
        chrome.storage.sync.get(
            keys = {
                missingPref: "skip"
            },
            (items) => {
                chrome.runtime.lastError
                ? reject(Error(chrome.runtime.lastError.message))
                : resolve (items.missingPref)
            }
        )
    })
    return p
}

function getAssignmentIdFromSubmissions(submissions) {
    if (!submissions || submissions.length === 0) {
        return null
    }
    return submissions[0].assign_id
}

function getAssignmentById(assignments, assign_id) {
    if (Object.keys(assignments).length == 0) {
        console.log('No assignments')
        return null
    }
    let my_assign = null
    assignments.forEach((a) => {
        if (a.id == assign_id) {
            my_assign = a
        }  
    })
    if (my_assign == null) {
        console.log(`Assignment ${assign_id} not found in ${assignments.length}`)
    }
    
    return my_assign
}

const getRubrics = (assignment) => {
    let rubrics = []
    assignment.rubric.forEach((r) => {
        // console.log(`rubric: ${JSON.stringify(r)}`)
        // console.log(`ALT code: ${r.description}\nALT Desc: ${r.long_description}`)
        let rubric = {
            id: r.id,
            alt_code: r.description,
            alt_text: r.long_description,
        }
        rubrics.push(rubric)
    })
    return(rubrics)
}

const getRubric = (assignment, rubric_id) => {
    rubric = {}
    getRubrics(assignment).forEach((r) =>{
        if (r.id == rubric_id) {
            rubric = r
        }  
    })
    return(rubric)
}

function getScoresFromSubmissionsByRubricId(submissions, rubric_id) {
    // submissions objects.keys = {assign_id, canvas_id, excused, grading_per, late, rubric_assessment{}, synergy_id}
    if (Object.keys(submissions).length == 0) {
        console.log(`No submissions`)
        return null
    }
    let scores = []
    submissions.forEach((s) => {
        let score = {}
        try {
            if ('rubric_assessment' in s) {
                Object.keys(s.rubric_assessment).forEach((r) => {
                    if (r == rubric_id) {

                        // console.log(`s.rubric_assessment[r] has keys ${Object.keys(s.rubric_assessment[r])}`)

                        let points = ''
                        if (Object.keys(s.rubric_assessment[r]).includes('points')) {
                            points = s.rubric_assessment[r].points
                        } else {
                            console.log(`Student ${s.canvas_id} / ${s.synergy_id} has no points for rubric_id ${r}`)
                            console.log('submission:',s)
                        }

                        score = {
                            'synergy_id': s.synergy_id,
                            'rubric_id' : rubric_id,
                            'score': points,
                            'short_name': s.short_name,
                            'excused': s.excused,
                            'late' : s.late,
                            'missing':s.missing,
                            'course_id': s.course_id,
                            'canvas_id': s.canvas_id,
                            'assign_id': s.assign_id,
                            'grading_per': s.grading_per,
                        }
                    }
                })
            } else if (s.excused | s.missing) {
                score = {
                    'synergy_id': s.synergy_id,
                    'rubric_id' : rubric_id,
                    'score': '',
                    'short_name': s.short_name,
                    'excused': s.excused,
                    'late' : s.late,
                    'missing': s.missing,
                    'course_id': s.course_id,
                    'canvas_id': s.canvas_id,
                    'assign_id': s.assign_id,
                    'grading_per': s.grading_per,
                }    
            }
        } catch (e) {
            console.log(`Error on score extract ${e}`)
            console.log(s)
        }
        if (Object.keys(score).length > 0) {
            scores.push(score)
        }
    })

    return scores
}

// needs to convert 1, 2, 3 and 1.33, 2.66/7 (?), 4 scores
const use_cgr = (scores, roundUpFrom) => {
    console.log(`Converting scores to CI, G, R behavior scores.`)
    scores.forEach((s) =>{
        let before = s.score
        if (s.score == '') {
            // pass
        } else if (s.score < 1+roundUpFrom) {
            s.score = 'R'
        } else if (s.score < 2+roundUpFrom) {
            s.score = 'G'
        } else if (s.score >= 2+roundUpFrom) {
            s.score = 'CI'
        }
        let after = s.score
        console.log(`cgr converted ${before} to ${after}`)
    })
    return(scores)
}

async function bg_get_submissions() {
    let submissions = []
    await chrome.storage.local.get(['submissions']).then((response) => {
        submissions = response.submissions || []
        console.log(`found ${submissions.length} submissions in local storage`)
    })

    if (submissions.length > 0) {
        let assign_id = getAssignmentIdFromSubmissions(submissions)
        console.log(`returning ${submissions.length} submissions for assign ${assign_id} from background.`)
    } else {
        console.log('No submissions found in local storage')
    }
    return(submissions)
}

async function bg_get_assignments() {
    let assignments = []
    await chrome.storage.local.get(['assignments']).then((response) => {
        assignments = response.assignments || []
        console.log(`Found ${assignments.length} assignments in local storage`)
    })
    console.log(`returning ${assignments.length} assignments from background`);
    return(assignments);
}

async function bg_get_submissions_by_assignment() {
    let submissions_by_assignment = {}
    await chrome.storage.local.get(['submissionsByAssignment']).then((response) => {
        submissions_by_assignment = response.submissionsByAssignment || {}
    })
    console.log(`returning submissionsByAssignment with ${Object.keys(submissions_by_assignment).length} assignment keys`)
    return submissions_by_assignment
}

async function bg_clear_all() {
    await chrome.storage.local.clear()
    await chrome.contextMenus.removeAll()
}

function bg_syn_update(score, synergy_id, row_index, col_index) {
    let docs = [document]
    try {
        if (window.frames && window.frames.length > 0) {
            for (let i = 0; i < window.frames.length; i++) {
                try {
                    if (window.frames[i] && window.frames[i].document) {
                        docs.push(window.frames[i].document)
                    }
                } catch (frameErr) {
                    // pass inaccessible frame
                }
            }
        }
    } catch (e) {
        // pass
    }

    let hostDoc = null
    let scoreTable = null
    for (let i = 0; i < docs.length; i++) {
        let table = docs[i].querySelector('.dx-datagrid-rowsview table')
        if (table) {
            hostDoc = docs[i]
            scoreTable = table
            break
        }
    }

    if (!hostDoc || !scoreTable) {
        throw new Error('Synergy score table not found in current document/frame.')
    }

    let targetRow = scoreTable.querySelector(`tr[aria-rowindex="${row_index}"]`)
    if (!targetRow) {
        throw new Error(`Could not find Synergy row ${row_index}.`)
    }

    let matchedRow = null
    scoreTable.querySelectorAll('tr[aria-rowindex]').forEach((rowEl) => {
        if (matchedRow) {
            return
        }
        let perm = rowEl.querySelector('span.student-perm-id')
        if (perm && String(perm.textContent || '').trim() === String(synergy_id)) {
            matchedRow = rowEl
        }
    })

    if (!matchedRow) {
        throw new Error(`Could not find Synergy row for student ID ${synergy_id}.`)
    }

    let matchedRowIndex = String(matchedRow.getAttribute('aria-rowindex') || '')
    if (matchedRowIndex !== String(row_index)) {
        throw new Error(`Received ${synergy_id}, row ${row_index} but should be row: ${matchedRowIndex}`)
    }

    let targetCell = targetRow.querySelector(`td[aria-colindex="${col_index}"]`)
    if (!targetCell) {
        throw new Error(`Target column ${col_index} was not found in row ${row_index}.`)
    }

    let cellWrap = targetCell.querySelector('div.asgn-cell-wrap')
    if (!cellWrap) {
        throw new Error(`Column ${col_index} is not a score-entry cell.`)
    }

    cellWrap.click()
    let input = cellWrap.querySelector('input')
    if (!input) {
        throw new Error(`Column ${col_index} did not expose an input after click.`)
    }

    input.value = score == null ? '' : String(score)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.blur()

    return {
        ok: true,
        row: String(row_index),
        col: String(col_index),
        synergy_id: String(synergy_id)
    }
}

async function call_syn_paste(tabId, submissions, rubric_id, convert_scores_to_cgr) {
    console.log(`call_syn_paste received: tabId, submissions, rubric_id, convert_scores_to_cgr:`, tabId, submissions, rubric_id, convert_scores_to_cgr)

    let scores = getScoresFromSubmissionsByRubricId(submissions, rubric_id)
    if (!scores || scores.length === 0) {
        console.log(`No scores available for rubric ${rubric_id}; skipping paste request`)
        return
    }

    let roundUpFrom = await getRoundingDecimal()
    let missingPref = await getMissingPref()

    console.log(`bg call_syn_paste, roundUpFrom (${roundUpFrom})`)
    // unfortunately this call is proceeding without getting the roundingDecimall... consider using then and wrapping.
    if (convert_scores_to_cgr) {
        scores = use_cgr(scores, roundUpFrom)
    }

    let my_message = {
        from: 'background.js',
        to: 'synergy.js',
        title: 'synergy_paste',
        body: 'Please paste values now',
        roundUpFrom: roundUpFrom,
        missingPref: missingPref,
        use_cgr: convert_scores_to_cgr,
        attachment: scores
    }

    chrome.tabs.sendMessage(tabId, my_message, (response) => {
        if (chrome.runtime.lastError) {
            console.log(`sendMessage to tab ${tabId} failed: ${chrome.runtime.lastError.message}`)
            return
        }
        console.log(`bg asked tab ${tabId} for paste with ${scores.length} scores and heard: ${response}`)
    })
}

function contextListener(info, tab) {
    // console.log('bg received click event...');
    bg_get_assignments().then((assignments)=> {
        bg_get_submissions().then((submissions) => {
            if (!assignments || assignments.length === 0 || !submissions || submissions.length === 0) {
                console.log('Context click ignored because assignments/submissions are not loaded')
                return
            }
            let assign_id = getAssignmentIdFromSubmissions(submissions)
            if (!assign_id) {
                console.log('Context click ignored because assignment id could not be determined')
                return
            }
            let assignment = getAssignmentById(assignments, assign_id)
            if (!assignment) {
                console.log(`Context click ignored because assignment ${assign_id} was not found`)
                return
            }
            if (info.menuItemId == 'assignment') {
                //pass 
            } else {
                // console.log('context click w/ info, tab}', info, tab)
                
                // console.log(`paste requested on url: ${sender.tab.url}`);
                rubric_id = info.menuItemId
                
                // console.log(`rubric_id: ${rubric_id}`)
                // console.log('Info: ',info)
                // let rubric = getRubric(assignment, rubric_id)
                // console.log(`User requested paste scores for ${rubric.alt_code} - ${assignment.name}`)
                // console.log(`call_syn_paste with ${tab.id} and ${rubric_id}`)

                let rubric = getRubric(assignment, rubric_id)
                if (!rubric || !rubric.alt_code) {
                    console.log(`Context click ignored because rubric ${rubric_id} was not found`)
                    return
                }
                let rubric_text = rubric.alt_code
                // console.log(rubric_text)
                let convert_scores_to_cgr = false
                if  (rubric_text.includes('BLT')) {
                    convert_scores_to_cgr = true
                }
                call_syn_paste(tab.id, submissions, rubric_id, convert_scores_to_cgr)
            }
        })
    })
}

function setupContextMenu(assignments, submissions) {
    console.log(`Setting up contextMenu with assignments, submissions:`)
    console.log(assignments, submissions)
    if (!assignments || assignments.length === 0 || !submissions || submissions.length === 0) {
        console.log('Skipping contextMenu setup because assignments/submissions are empty')
        return
    }
    let assign_id = getAssignmentIdFromSubmissions(submissions)
    if (!assign_id) {
        console.log('Skipping contextMenu setup because assignment id was not found in submissions')
        return
    }
    // console.log(`getAssignment id: ${assign_id}`)

    // fetches assignments from global var...
    // convert to storage request...
    let assignment = getAssignmentById(assignments, assign_id)
    if (!assignment) {
        console.log(`Skipping contextMenu setup because assignment ${assign_id} was not found`)
        return
    }
    let rubrics = getRubrics(assignment)

    // update contextMenu
    chrome.contextMenus.removeAll()
    chrome.contextMenus.create(
        createProperties = {
            id: 'assignment', 
            title: assignment.name,
            contexts: ["editable"],
            type: 'normal',
            documentUrlPatterns: ["https://synergy.beaverton.k12.or.us/*","https://syntrn.beaverton.k12.or.us/*"]
        });

    rubrics.forEach((r, index) => {
        let alt_code, alt_text
        alt_code = r.alt_code
        
        if (r.alt_text == null) {
            alt_text = '(no outcome description available)'
        } else {
            alt_text = r.alt_text.slice(0, 35)
        }
        
        chrome.contextMenus.create(
            createProperties = {
                id: r.id, 
                parentId: 'assignment',
                title: `${alt_code} - ${alt_text}`,
                contexts: ["editable"],
                type: 'normal',
                documentUrlPatterns: ["https://synergy.beaverton.k12.or.us/*","https://syntrn.beaverton.k12.or.us/*"]
            }
        )
    })
    addContextListener()
}

function addContextListener() {
    if (!chrome.contextMenus.onClicked.hasListener(contextListener)) {
        console.log('No contextMenu listener, adding contextListener!')
        chrome.contextMenus.onClicked.addListener(contextListener)    
    } else {
        console.log('Already have contextListener for contextMenu, no additional listener being added')
    }
}

function mainListener(request, sender, sendResponse) {
    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "sending_assignments") {
        console.log('Background received a message from popup.js: ' + request.body);
        
        let assignments = request.attachment;
        chrome.storage.local.set({
            'assignments': assignments
        }, () => {
            console.log(`${assignments.length} assignments written to local storage`)
        })
        sendResponse('Thanks for sending! Assignments updated in background')
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "sending_submissions") {
        console.log('Background received a message from popup.js: ' + request.body);

        let submissions = request.attachment;
        chrome.storage.local.set({
            'submissions': submissions
        },() => {
            console.log(`${submissions.length} submissions sent to local storage`)
        })

        // fetch assignments from local.storage

        chrome.storage.local.get(['assignments','submissions']).then((result) => {
            let assignments = result.assignments
            // we have submissions from the listener and assignments from storage...
            // let's make the menu!
            setupContextMenu(assignments, submissions)
        })

        // if submissions exist, then there should be assignments
        sendResponse('Thanks for sending! Submissions updated in background');
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "sending_submissions_bulk") {
        console.log('Background received bulk submissions from popup.js')
        let submissions_by_assignment = request.attachment || {}
        let assignment_keys = Object.keys(submissions_by_assignment)

        chrome.storage.local.set({
            'submissionsByAssignment': submissions_by_assignment
        }, () => {
            console.log(`Stored submissionsByAssignment with ${assignment_keys.length} keys`)
        })

        // Keep single-submission payload in sync for legacy context-menu flow.
        if (assignment_keys.length > 0) {
            let first_key = assignment_keys[0]
            let first_submissions = submissions_by_assignment[first_key] || []

            chrome.storage.local.set({
                'submissions': first_submissions
            }, () => {
                console.log(`Updated legacy submissions with ${first_submissions.length} entries from assignment ${first_key}`)
            })

            if (first_submissions.length > 0) {
                chrome.storage.local.get(['assignments']).then((result) => {
                    let assignments = result.assignments || []
                    if (assignments.length > 0) {
                        setupContextMenu(assignments, first_submissions)
                    }
                })
            }
        }

        sendResponse(`Stored bulk submissions for ${assignment_keys.length} assignments`)
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "checking_for_assignments") {
        console.log('Background received a message from popup.js: ' + request.body);
        bg_get_assignments()
        .then((assignments) => {
            console.log('bg_get_assignments returned assignments:')
            console.log(assignments)
            if (assignments == null) {
                sendResponse(false);
            } else {
                sendResponse(assignments);
            }
        })
        return true
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "checking_for_submissions") {
        console.log('Background received a message from popup.js: ' + request.body)
        bg_get_submissions()
        .then((submissions) => {
            if (submissions == null) {
                sendResponse(false)
            } else {
                bg_get_assignments().then((assignments) => {
                    setupContextMenu(assignments, submissions)
                })
                getRoundingDecimal().then((roundUpFrom) => {
                    getMissingPref().then((missingPref) => {
                        let response = {
                            'roundUpFrom': roundUpFrom,
                            'missingPref': missingPref,
                            'submissions': submissions
                        }
                        sendResponse(response)
                    })
                    
                })
                
            }
        })
        return true
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "checking_for_submissions_bulk") {
        bg_get_submissions_by_assignment().then((submissions_by_assignment) => {
            sendResponse(submissions_by_assignment)
        })
        return true
    }

    if (request.from == 'popup.js' & request.to == "background.js" & request.title == "clear_data") {
        console.log('Background received a message from popup.js: ' + request.body)
        
        bg_clear_all().then(() => {
            sendResponse('Background cleared storage data and removed contextMenus!')
        })
        
        return true
    }

    if (request.from == 'synergy.js' & request.to == 'background.js' & request.title == 'inject') {
        // Process script inject...
        // console.log(`Received inject request: ${request.injectScript}`);
        // console.log(`Request contains: ${JSON.stringify(request)}`)
        // console.log(`Sending tab: ${sender.tab.id}`)
        chrome.scripting.executeScript({
            world: 'MAIN',
            args: [request.score, request.synergy_id, request.row, request.col], // score, sis_number, row_index, col_index
            target: {tabId: sender.tab.id},
            func: bg_syn_update
        }).then(injectionResults => {
            let successfulResult = null
            for (const frameResult of injectionResults) {
                if (frameResult && frameResult.result && frameResult.result.ok) {
                    successfulResult = frameResult.result
                    break
                }
            }
            if (!successfulResult) {
                sendResponse({ ok: false, error: 'Injection completed but no editable score cell was updated.' })
                return
            }
            sendResponse({ ok: true, result: successfulResult })
        }).catch((e) => {
            console.log('Injection failed:', e)
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
        });
        return true
    }
}
// listening for events from popup...
if (!chrome.runtime.onMessage.hasListener(mainListener)) {
    console.log('No runtime listener found, adding ::mainListener:: to runtime.onMessage...')
    chrome.runtime.onMessage.addListener(mainListener)
} else {
    console.log('Already have mainListener, not adding additional')
}

addContextListener()

// chrome.runtime.onSuspend.addListener(() => {
//     console.log('Background knows that unload is coming soon... time to disable contextMenus?')
//     chrome.ContextMenus.removeAll()
// })
