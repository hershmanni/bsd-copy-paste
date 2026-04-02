// TODO
// update contextMenu persistence...

const ACTION_POPUP_INFO = 'popup_info.html'
const SIDEPANEL_PATH = 'sidepanel.html'

function isSynergyUrl(url) {
    return Boolean(
        url &&
        (
            String(url).match(/^https\:\/\/synergy\.beaverton\.k12\.or\.us\//) ||
            String(url).match(/^https\:\/\/syntrn\.beaverton\.k12\.or\.us\//)
        )
    )
}

function isMessagingConnectionError(err) {
    let message = String(err && err.message ? err.message : err || '')
    return (
        message.includes('Could not establish connection') ||
        message.includes('Receiving end does not exist')
    )
}

function sendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
                return
            }
            resolve(response)
        })
    })
}

async function ensureSynergyContentScript(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['scripts/jquery-3.6.3.min.js', 'scripts/synergy.js']
    })
}

async function checkSynergyGradebookTab(tab) {
    if (!tab || !tab.id || !isSynergyUrl(tab.url)) {
        return { eligible: false, reason: 'Not a Synergy tab.' }
    }

    let message = {
        from: 'background.js',
        to: 'synergy.js',
        title: 'check_gradebook_page'
    }

    try {
        let response = await sendMessageToTab(tab.id, message)
        if (response && response.ok === true) {
            return {
                eligible: Boolean(response.eligible),
                reason: response.reason || ''
            }
        }
    } catch (e) {
        if (!isMessagingConnectionError(e)) {
            return { eligible: false, reason: String(e && e.message ? e.message : e) }
        }

        try {
            await ensureSynergyContentScript(tab.id)
            let retry = await sendMessageToTab(tab.id, message)
            if (retry && retry.ok === true) {
                return {
                    eligible: Boolean(retry.eligible),
                    reason: retry.reason || ''
                }
            }
        } catch (retryErr) {
            return { eligible: false, reason: String(retryErr && retryErr.message ? retryErr.message : retryErr) }
        }
    }

    return { eligible: false, reason: 'Could not verify Synergy Grade Book page.' }
}

async function setActionPopupSafe(tabId, popupPath) {
    try {
        await chrome.action.setPopup({
            tabId: tabId,
            popup: popupPath
        })
    } catch (e) {
        console.log('setPopup failed', e)
    }
}

async function setSidePanelOptionsSafe(tabId, enabled) {
    if (!chrome.sidePanel || !chrome.sidePanel.setOptions) {
        return
    }
    try {
        await chrome.sidePanel.setOptions({
            tabId: tabId,
            path: SIDEPANEL_PATH,
            enabled: Boolean(enabled)
        })
    } catch (e) {
        console.log('sidePanel.setOptions failed', e)
    }
}

async function configureActionForTab(tab) {
    if (!tab || !tab.id) {
        return
    }

    let popupPath = ACTION_POPUP_INFO
    let sidePanelEnabled = false

    if (isSynergyUrl(tab.url)) {
        let check = await checkSynergyGradebookTab(tab)
        if (check.eligible) {
            popupPath = ''
            sidePanelEnabled = true
        } else {
            popupPath = ACTION_POPUP_INFO
            sidePanelEnabled = false
        }
    }

    await setActionPopupSafe(tab.id, popupPath)
    await setSidePanelOptionsSafe(tab.id, sidePanelEnabled)
}

async function configureActionForTabId(tabId) {
    try {
        let tab = await chrome.tabs.get(tabId)
        await configureActionForTab(tab)
    } catch (e) {
        // tab might have closed
    }
}

async function configureActionForActiveTabs() {
    try {
        let tabs = await chrome.tabs.query({ active: true })
        for (let i = 0; i < tabs.length; i++) {
            await configureActionForTab(tabs[i])
        }
    } catch (e) {
        console.log('configureActionForActiveTabs failed', e)
    }
}

async function handleActionClick(tab) {
    if (!tab || !tab.id) {
        return
    }

    if (!isSynergyUrl(tab.url)) {
        await setActionPopupSafe(tab.id, ACTION_POPUP_INFO)
        return
    }

    if (chrome.sidePanel && chrome.sidePanel.open) {
        try {
            // Must be called directly in the user gesture path.
            await chrome.sidePanel.open({ tabId: tab.id })
        } catch (e) {
            console.log('sidePanel.open failed', e)
        }
    }

    // Re-validate tab eligibility after opening attempt so action/panel state stays in sync.
    configureActionForTab(tab).catch((e) => {
        console.log('configureActionForTab after action click failed', e)
    })
}

function onTabActivated(activeInfo) {
    configureActionForTabId(activeInfo.tabId)
}

function onTabUpdated(tabId, changeInfo, tab) {
    if (!changeInfo || (!Object.prototype.hasOwnProperty.call(changeInfo, 'url') && changeInfo.status !== 'complete')) {
        return
    }
    configureActionForTab(tab)
}

function onRuntimeLifecycle() {
    configureActionForActiveTabs()
}



// function get_rubric_id_from_scores(scores) {
//     // assuming multiple scores
//     return scores[0].rubric_id
// }

async function getRoundingDecimal() {
    let p = new Promise((resolve, reject) => {
        chrome.storage.sync.get(
            {
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
            {
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
    let rubric = {}
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
                        let rubricMissing = points === '' || points == null

                        score = {
                            'synergy_id': s.synergy_id,
                            'rubric_id' : rubric_id,
                            'score': points,
                            'short_name': s.short_name,
                            'excused': s.excused,
                            'late' : s.late,
                            // Treat blank rubric points as missing so Missing/zero preference applies.
                            'missing': Boolean(s.missing || rubricMissing),
                            'course_id': s.course_id,
                            'canvas_id': s.canvas_id,
                            'assign_id': s.assign_id,
                            'grading_per': s.grading_per,
                        }
                    }
                })
            } else if (s.excused || s.missing) {
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
    function normalizeScoreEntryValue(value) {
        let normalized = String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase()

        if (!normalized) {
            return ''
        }

        return normalized
            .split(' ')
            .filter(Boolean)
            .filter((token) => token !== '!' && token !== '!EX')
            .join(' ')
    }

    function normalizeDisplayText(value) {
        return String(value == null ? '' : value)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    function getHeaderTemplateType(headerCell) {
        if (!headerCell) {
            return ''
        }

        let templateNode = headerCell.querySelector('[data-options*="dxTemplate"]')
        let options = String(templateNode ? templateNode.getAttribute('data-options') || '' : '')
        if (options.includes('standardsAssignmentHeaderTemplate')) {
            return 'standards_assignment'
        }
        if (options.includes('standardsHeaderTemplate')) {
            return 'standards'
        }
        if (options.includes('assignmentHeaderNoScoreEntryTemplate')) {
            return 'comment'
        }
        if (options.includes('assignmentHeaderTemplate')) {
            return 'assignment'
        }
        return ''
    }

    function getHeaderCellText(headerCell) {
        if (!headerCell) {
            return ''
        }

        let assignmentTitle = normalizeDisplayText(
            (headerCell.querySelector('.assignment-title span') || {}).textContent || ''
        )
        if (assignmentTitle) {
            return assignmentTitle
        }

        let bandLabel = normalizeDisplayText(
            (headerCell.querySelector('.header-cell.band-cell') || {}).textContent || ''
        )
        if (bandLabel) {
            return bandLabel
        }

        let clean = normalizeDisplayText(headerCell.textContent || '')
        if (clean) {
            return clean
        }

        let ariaLabel = normalizeDisplayText(headerCell.getAttribute('aria-label') || '')
        if (ariaLabel.toLowerCase().startsWith('column ')) {
            ariaLabel = ariaLabel.slice(7).trim()
        }
        return ariaLabel
    }

    function getHeaderBandRanges(headerRows) {
        let ranges = []
        if (!Array.isArray(headerRows) || headerRows.length < 2) {
            return ranges
        }

        let cursor = 0
        Array.from(headerRows[0].querySelectorAll('td[role="columnheader"]')).forEach((cell) => {
            let rowSpan = Number(cell.getAttribute('rowspan') || 1)
            let colSpan = Number(cell.getAttribute('colspan') || 1)
            if (rowSpan >= 2) {
                return
            }

            ranges.push({
                start: cursor,
                end: cursor + colSpan - 1,
                label: getHeaderCellText(cell)
            })
            cursor += colSpan
        })

        return ranges
    }

    function getBandLabelForLeafIndex(leafIndex, bandRanges) {
        for (let i = 0; i < bandRanges.length; i++) {
            let band = bandRanges[i]
            if (leafIndex >= band.start && leafIndex <= band.end) {
                return band.label
            }
        }
        return ''
    }

    function buildHeaderMetaById(rootDoc) {
        let metaById = {}
        let headerRows = Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table tr'))
        if (headerRows.length === 0) {
            return metaById
        }

        Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table td[role="columnheader"][id]')).forEach((cell) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }

            metaById[id] = {
                leafLabel: getHeaderCellText(cell),
                bandLabel: '',
                templateType: getHeaderTemplateType(cell)
            }
        })

        if (headerRows.length < 2) {
            return metaById
        }

        let bandRanges = getHeaderBandRanges(headerRows)
        let leafHeaders = Array.from(
            headerRows[headerRows.length - 1].querySelectorAll('td[role="columnheader"][id]')
        )

        leafHeaders.forEach((cell, leafIndex) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }
            if (!metaById[id]) {
                metaById[id] = {
                    leafLabel: getHeaderCellText(cell),
                    bandLabel: '',
                    templateType: getHeaderTemplateType(cell)
                }
            }
            metaById[id].bandLabel = getBandLabelForLeafIndex(leafIndex, bandRanges)
            metaById[id].templateType = getHeaderTemplateType(cell)
        })

        return metaById
    }

    function buildCommentColumnMap(scoreTableEl, rootDoc) {
        let map = {}
        let firstDataRow = Array.from(scoreTableEl.querySelectorAll('tr[aria-rowindex]')).find((rowEl) => {
            return rowEl.querySelector('td[aria-colindex]') !== null
        })
        if (!firstDataRow) {
            return map
        }

        let headerMetaById = buildHeaderMetaById(rootDoc)
        let visibleCols = Array.from(firstDataRow.querySelectorAll('td[aria-colindex]')).map((cell) => {
            let colIndex = String(cell.getAttribute('aria-colindex') || '').trim()
            let headerId = String(cell.getAttribute('aria-describedby') || '').trim()
            let meta = headerMetaById[headerId] || {}
            let leafLabel = normalizeDisplayText(meta.leafLabel || '')
            let bandLabel = normalizeDisplayText(meta.bandLabel || '')
            let templateType = String(meta.templateType || '')
            let isComment = (
                templateType === 'comment' ||
                leafLabel.toLowerCase() === 'cmt' ||
                Boolean(cell.querySelector('.cell-flag.cmt-code'))
            )

            return {
                colIndex: colIndex,
                order: Number(colIndex),
                bandLabel: bandLabel,
                isComment: isComment
            }
        }).filter((column) => column.colIndex)

        let columnsByBand = {}
        visibleCols.forEach((column) => {
            let key = column.bandLabel || ''
            if (!key) {
                return
            }
            if (!columnsByBand[key]) {
                columnsByBand[key] = []
            }
            columnsByBand[key].push(column)
        })

        Object.keys(columnsByBand).forEach((key) => {
            let group = columnsByBand[key]
            let commentCols = group.filter((column) => column.isComment)
            if (commentCols.length === 0) {
                return
            }

            group.forEach((column) => {
                if (column.isComment || map[column.colIndex]) {
                    return
                }

                let match = commentCols
                    .filter((commentCol) => commentCol.order > column.order)
                    .sort((a, b) => a.order - b.order)[0]

                if (!match) {
                    match = commentCols
                        .slice()
                        .sort((a, b) => Math.abs(a.order - column.order) - Math.abs(b.order - column.order))[0]
                }

                if (match) {
                    map[column.colIndex] = match.colIndex
                }
            })
        })

        let sortedCols = visibleCols.slice().sort((a, b) => a.order - b.order)
        sortedCols.forEach((column, index) => {
            if (!column.isComment) {
                return
            }

            for (let leftIndex = index - 1; leftIndex >= 0; leftIndex--) {
                let leftColumn = sortedCols[leftIndex]
                if (leftColumn.isComment) {
                    break
                }
                if (!map[leftColumn.colIndex]) {
                    map[leftColumn.colIndex] = column.colIndex
                }
            }
        })

        return map
    }

    function getEditableScoreInput(cellWrap, targetColIndex) {
        let input = cellWrap.querySelector('input')
        if (input) {
            return input
        }

        cellWrap.click()
        input = cellWrap.querySelector('input')
        if (!input) {
            throw new Error(`Column ${targetColIndex} did not expose an input after click.`)
        }

        return input
    }

    function getCellScoreDisplayValue(targetCell) {
        if (!targetCell) {
            return ''
        }

        let scoreNode = targetCell.querySelector('.asgn-cell .score')
        if (scoreNode) {
            return normalizeDisplayText(scoreNode.textContent || '')
        }

        let cellNode = targetCell.querySelector('.asgn-cell')
        if (cellNode) {
            return normalizeDisplayText(cellNode.textContent || '')
        }

        return ''
    }

    function getCellCommentDisplayValue(targetCell) {
        if (!targetCell) {
            return ''
        }

        let commentNode = targetCell.querySelector('.cell-flag.cmt-code')
        return normalizeDisplayText(commentNode ? commentNode.textContent || '' : '')
    }

    function getCurrentCompositeValue(targetCell, targetRow, targetColIndex, commentColByScoreCol) {
        let scoreValue = getCellScoreDisplayValue(targetCell)
        let cellWrap = targetCell ? targetCell.querySelector('div.asgn-cell-wrap') : null
        if (cellWrap) {
            let input = getEditableScoreInput(cellWrap, targetColIndex)
            if (input) {
                scoreValue = normalizeDisplayText(input.value || '')
                input.blur()
            }
        }

        let commentValue = ''
        let commentColIndex = String(commentColByScoreCol[String(targetColIndex).trim()] || '').trim()
        if (commentColIndex && targetRow) {
            let commentCell = targetRow.querySelector(`td[aria-colindex="${commentColIndex}"]`)
            commentValue = getCellCommentDisplayValue(commentCell)
        } else {
            commentValue = getCellCommentDisplayValue(targetCell)
        }

        return normalizeDisplayText([scoreValue, commentValue].filter(Boolean).join(' '))
    }

    function applyScoreValue(targetCell, targetRow, nextScore, targetColIndex, commentColByScoreCol) {
        let cellWrap = targetCell.querySelector('div.asgn-cell-wrap')
        if (!cellWrap) {
            throw new Error(`Column ${targetColIndex} is not a score-entry cell.`)
        }

        let input = getEditableScoreInput(cellWrap, targetColIndex)
        let nextValue = nextScore == null ? '' : String(nextScore)
        let currentValue = getCurrentCompositeValue(targetCell, targetRow, targetColIndex, commentColByScoreCol)

        if (normalizeScoreEntryValue(currentValue) === normalizeScoreEntryValue(nextValue)) {
            input.blur()
            return {
                updated: false,
                skipped_identical: true
            }
        }

        input.value = nextValue
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        input.blur()

        return {
            updated: true,
            skipped_identical: false
        }
    }

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

    let commentColByScoreCol = buildCommentColumnMap(scoreTable, hostDoc)
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

    let writeResult = applyScoreValue(targetCell, targetRow, score, col_index, commentColByScoreCol)

    return {
        ok: true,
        row: String(row_index),
        col: String(col_index),
        synergy_id: String(synergy_id),
        updated: Boolean(writeResult.updated),
        skipped_identical: Boolean(writeResult.skipped_identical)
    }
}

function bg_syn_update_batch(updates) {
    function normalizeScoreEntryValue(value) {
        let normalized = String(value == null ? '' : value)
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase()

        if (!normalized) {
            return ''
        }

        return normalized
            .split(' ')
            .filter(Boolean)
            .filter((token) => token !== '!' && token !== '!EX')
            .join(' ')
    }

    function normalizeDisplayText(value) {
        return String(value == null ? '' : value)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    function getHeaderTemplateType(headerCell) {
        if (!headerCell) {
            return ''
        }

        let templateNode = headerCell.querySelector('[data-options*="dxTemplate"]')
        let options = String(templateNode ? templateNode.getAttribute('data-options') || '' : '')
        if (options.includes('standardsAssignmentHeaderTemplate')) {
            return 'standards_assignment'
        }
        if (options.includes('standardsHeaderTemplate')) {
            return 'standards'
        }
        if (options.includes('assignmentHeaderNoScoreEntryTemplate')) {
            return 'comment'
        }
        if (options.includes('assignmentHeaderTemplate')) {
            return 'assignment'
        }
        return ''
    }

    function getHeaderCellText(headerCell) {
        if (!headerCell) {
            return ''
        }

        let assignmentTitle = normalizeDisplayText(
            (headerCell.querySelector('.assignment-title span') || {}).textContent || ''
        )
        if (assignmentTitle) {
            return assignmentTitle
        }

        let bandLabel = normalizeDisplayText(
            (headerCell.querySelector('.header-cell.band-cell') || {}).textContent || ''
        )
        if (bandLabel) {
            return bandLabel
        }

        let clean = normalizeDisplayText(headerCell.textContent || '')
        if (clean) {
            return clean
        }

        let ariaLabel = normalizeDisplayText(headerCell.getAttribute('aria-label') || '')
        if (ariaLabel.toLowerCase().startsWith('column ')) {
            ariaLabel = ariaLabel.slice(7).trim()
        }
        return ariaLabel
    }

    function getHeaderBandRanges(headerRows) {
        let ranges = []
        if (!Array.isArray(headerRows) || headerRows.length < 2) {
            return ranges
        }

        let cursor = 0
        Array.from(headerRows[0].querySelectorAll('td[role="columnheader"]')).forEach((cell) => {
            let rowSpan = Number(cell.getAttribute('rowspan') || 1)
            let colSpan = Number(cell.getAttribute('colspan') || 1)
            if (rowSpan >= 2) {
                return
            }

            ranges.push({
                start: cursor,
                end: cursor + colSpan - 1,
                label: getHeaderCellText(cell)
            })
            cursor += colSpan
        })

        return ranges
    }

    function getBandLabelForLeafIndex(leafIndex, bandRanges) {
        for (let i = 0; i < bandRanges.length; i++) {
            let band = bandRanges[i]
            if (leafIndex >= band.start && leafIndex <= band.end) {
                return band.label
            }
        }
        return ''
    }

    function buildHeaderMetaById(rootDoc) {
        let metaById = {}
        let headerRows = Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table tr'))
        if (headerRows.length === 0) {
            return metaById
        }

        Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table td[role="columnheader"][id]')).forEach((cell) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }

            metaById[id] = {
                leafLabel: getHeaderCellText(cell),
                bandLabel: '',
                templateType: getHeaderTemplateType(cell)
            }
        })

        if (headerRows.length < 2) {
            return metaById
        }

        let bandRanges = getHeaderBandRanges(headerRows)
        let leafHeaders = Array.from(
            headerRows[headerRows.length - 1].querySelectorAll('td[role="columnheader"][id]')
        )

        leafHeaders.forEach((cell, leafIndex) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }
            if (!metaById[id]) {
                metaById[id] = {
                    leafLabel: getHeaderCellText(cell),
                    bandLabel: '',
                    templateType: getHeaderTemplateType(cell)
                }
            }
            metaById[id].bandLabel = getBandLabelForLeafIndex(leafIndex, bandRanges)
            metaById[id].templateType = getHeaderTemplateType(cell)
        })

        return metaById
    }

    function buildCommentColumnMap(scoreTableEl, rootDoc) {
        let map = {}
        let firstDataRow = Array.from(scoreTableEl.querySelectorAll('tr[aria-rowindex]')).find((rowEl) => {
            return rowEl.querySelector('td[aria-colindex]') !== null
        })
        if (!firstDataRow) {
            return map
        }

        let headerMetaById = buildHeaderMetaById(rootDoc)
        let visibleCols = Array.from(firstDataRow.querySelectorAll('td[aria-colindex]')).map((cell) => {
            let colIndex = String(cell.getAttribute('aria-colindex') || '').trim()
            let headerId = String(cell.getAttribute('aria-describedby') || '').trim()
            let meta = headerMetaById[headerId] || {}
            let leafLabel = normalizeDisplayText(meta.leafLabel || '')
            let bandLabel = normalizeDisplayText(meta.bandLabel || '')
            let templateType = String(meta.templateType || '')
            let isComment = (
                templateType === 'comment' ||
                leafLabel.toLowerCase() === 'cmt' ||
                Boolean(cell.querySelector('.cell-flag.cmt-code'))
            )

            return {
                colIndex: colIndex,
                order: Number(colIndex),
                bandLabel: bandLabel,
                isComment: isComment
            }
        }).filter((column) => column.colIndex)

        let columnsByBand = {}
        visibleCols.forEach((column) => {
            let key = column.bandLabel || ''
            if (!key) {
                return
            }
            if (!columnsByBand[key]) {
                columnsByBand[key] = []
            }
            columnsByBand[key].push(column)
        })

        Object.keys(columnsByBand).forEach((key) => {
            let group = columnsByBand[key]
            let commentCols = group.filter((column) => column.isComment)
            if (commentCols.length === 0) {
                return
            }

            group.forEach((column) => {
                if (column.isComment || map[column.colIndex]) {
                    return
                }

                let match = commentCols
                    .filter((commentCol) => commentCol.order > column.order)
                    .sort((a, b) => a.order - b.order)[0]

                if (!match) {
                    match = commentCols
                        .slice()
                        .sort((a, b) => Math.abs(a.order - column.order) - Math.abs(b.order - column.order))[0]
                }

                if (match) {
                    map[column.colIndex] = match.colIndex
                }
            })
        })

        let sortedCols = visibleCols.slice().sort((a, b) => a.order - b.order)
        sortedCols.forEach((column, index) => {
            if (!column.isComment) {
                return
            }

            for (let leftIndex = index - 1; leftIndex >= 0; leftIndex--) {
                let leftColumn = sortedCols[leftIndex]
                if (leftColumn.isComment) {
                    break
                }
                if (!map[leftColumn.colIndex]) {
                    map[leftColumn.colIndex] = column.colIndex
                }
            }
        })

        return map
    }

    function getEditableScoreInput(cellWrap, targetColIndex) {
        let input = cellWrap.querySelector('input')
        if (input) {
            return input
        }

        cellWrap.click()
        input = cellWrap.querySelector('input')
        if (!input) {
            throw new Error(`Column ${targetColIndex} did not expose an input after click.`)
        }

        return input
    }

    function getCellScoreDisplayValue(targetCell) {
        if (!targetCell) {
            return ''
        }

        let scoreNode = targetCell.querySelector('.asgn-cell .score')
        if (scoreNode) {
            return normalizeDisplayText(scoreNode.textContent || '')
        }

        let cellNode = targetCell.querySelector('.asgn-cell')
        if (cellNode) {
            return normalizeDisplayText(cellNode.textContent || '')
        }

        return ''
    }

    function getCellCommentDisplayValue(targetCell) {
        if (!targetCell) {
            return ''
        }

        let commentNode = targetCell.querySelector('.cell-flag.cmt-code')
        return normalizeDisplayText(commentNode ? commentNode.textContent || '' : '')
    }

    function getCurrentCompositeValue(targetCell, targetRow, targetColIndex, commentColByScoreCol) {
        let scoreValue = getCellScoreDisplayValue(targetCell)
        let cellWrap = targetCell ? targetCell.querySelector('div.asgn-cell-wrap') : null
        if (cellWrap) {
            let input = getEditableScoreInput(cellWrap, targetColIndex)
            if (input) {
                scoreValue = normalizeDisplayText(input.value || '')
                input.blur()
            }
        }

        let commentValue = ''
        let commentColIndex = String(commentColByScoreCol[String(targetColIndex).trim()] || '').trim()
        if (commentColIndex && targetRow) {
            let commentCell = targetRow.querySelector(`td[aria-colindex="${commentColIndex}"]`)
            commentValue = getCellCommentDisplayValue(commentCell)
        } else {
            commentValue = getCellCommentDisplayValue(targetCell)
        }

        return normalizeDisplayText([scoreValue, commentValue].filter(Boolean).join(' '))
    }

    function applyScoreValue(targetCell, targetRow, nextScore, targetColIndex, commentColByScoreCol) {
        let cellWrap = targetCell.querySelector('div.asgn-cell-wrap')
        if (!cellWrap) {
            throw new Error(`Column ${targetColIndex} is not a score-entry cell.`)
        }

        let input = getEditableScoreInput(cellWrap, targetColIndex)
        let nextValue = nextScore == null ? '' : String(nextScore)
        let currentValue = getCurrentCompositeValue(targetCell, targetRow, targetColIndex, commentColByScoreCol)

        if (normalizeScoreEntryValue(currentValue) === normalizeScoreEntryValue(nextValue)) {
            input.blur()
            return {
                updated: false,
                skipped_identical: true
            }
        }

        input.value = nextValue
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        input.blur()

        return {
            updated: true,
            skipped_identical: false
        }
    }

    let safeUpdates = Array.isArray(updates) ? updates : []
    if (safeUpdates.length === 0) {
        return {
            ok: true,
            updated_count: 0,
            skipped_identical_count: 0,
            failed_count: 0,
            results: []
        }
    }

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

    let commentColByScoreCol = buildCommentColumnMap(scoreTable, hostDoc)
    let rowByIndex = {}
    let rowBySynergyId = {}
    scoreTable.querySelectorAll('tr[aria-rowindex]').forEach((rowEl) => {
        let rowIndex = String(rowEl.getAttribute('aria-rowindex') || '')
        if (rowIndex && !rowByIndex[rowIndex]) {
            rowByIndex[rowIndex] = rowEl
        }
        let perm = rowEl.querySelector('span.student-perm-id')
        let synergyId = String((perm && perm.textContent) || '').trim()
        if (synergyId && !rowBySynergyId[synergyId]) {
            rowBySynergyId[synergyId] = rowEl
        }
    })

    let updatedCount = 0
    let skippedIdenticalCount = 0
    let failedCount = 0
    let results = []

    safeUpdates.forEach((rawUpdate) => {
        let update = rawUpdate && typeof rawUpdate === 'object' ? rawUpdate : {}
        let score = update.score == null ? '' : String(update.score)
        let synergyId = String(update.synergy_id || '').trim()
        let rowIndex = String(update.row || '').trim()
        let colIndex = String(update.col || '').trim()

        try {
            if (!synergyId || !rowIndex || !colIndex) {
                throw new Error('Batch update entry is missing synergy_id, row, or col.')
            }

            let targetRow = rowByIndex[rowIndex]
            if (!targetRow) {
                throw new Error(`Could not find Synergy row ${rowIndex}.`)
            }

            let matchedRow = rowBySynergyId[synergyId]
            if (!matchedRow) {
                throw new Error(`Could not find Synergy row for student ID ${synergyId}.`)
            }

            let matchedRowIndex = String(matchedRow.getAttribute('aria-rowindex') || '')
            if (matchedRowIndex !== rowIndex) {
                throw new Error(`Received ${synergyId}, row ${rowIndex} but should be row: ${matchedRowIndex}`)
            }

            let targetCell = targetRow.querySelector(`td[aria-colindex="${colIndex}"]`)
            if (!targetCell) {
                throw new Error(`Target column ${colIndex} was not found in row ${rowIndex}.`)
            }

            let writeResult = applyScoreValue(targetCell, targetRow, score, colIndex, commentColByScoreCol)
            if (writeResult.updated) {
                updatedCount++
            } else if (writeResult.skipped_identical) {
                skippedIdenticalCount++
            }
            results.push({
                ok: true,
                synergy_id: synergyId,
                row: rowIndex,
                col: colIndex,
                updated: Boolean(writeResult.updated),
                skipped_identical: Boolean(writeResult.skipped_identical)
            })
        } catch (e) {
            failedCount++
            results.push({
                ok: false,
                synergy_id: synergyId,
                row: rowIndex,
                col: colIndex,
                error: e && e.message ? e.message : String(e)
            })
        }
    })

    return {
        ok: true,
        updated_count: updatedCount,
        skipped_identical_count: skippedIdenticalCount,
        failed_count: failedCount,
        results: results
    }
}

function bg_syn_get_score_table_preview(colIndexes) {
    function normalizeDisplayText(value) {
        return String(value == null ? '' : value)
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    }

    function getHeaderTemplateType(headerCell) {
        if (!headerCell) {
            return ''
        }

        let templateNode = headerCell.querySelector('[data-options*="dxTemplate"]')
        let options = String(templateNode ? templateNode.getAttribute('data-options') || '' : '')
        if (options.includes('standardsAssignmentHeaderTemplate')) {
            return 'standards_assignment'
        }
        if (options.includes('standardsHeaderTemplate')) {
            return 'standards'
        }
        if (options.includes('assignmentHeaderNoScoreEntryTemplate')) {
            return 'comment'
        }
        if (options.includes('assignmentHeaderTemplate')) {
            return 'assignment'
        }
        return ''
    }

    function getHeaderCellText(headerCell) {
        if (!headerCell) {
            return ''
        }

        let assignmentTitle = normalizeDisplayText(
            (headerCell.querySelector('.assignment-title span') || {}).textContent || ''
        )
        if (assignmentTitle) {
            return assignmentTitle
        }

        let bandLabel = normalizeDisplayText(
            (headerCell.querySelector('.header-cell.band-cell') || {}).textContent || ''
        )
        if (bandLabel) {
            return bandLabel
        }

        let clean = normalizeDisplayText(headerCell.textContent || '')
        if (clean) {
            return clean
        }

        let ariaLabel = normalizeDisplayText(headerCell.getAttribute('aria-label') || '')
        if (ariaLabel.toLowerCase().startsWith('column ')) {
            ariaLabel = ariaLabel.slice(7).trim()
        }
        return ariaLabel
    }

    function getHeaderBandRanges(headerRows) {
        let ranges = []
        if (!Array.isArray(headerRows) || headerRows.length < 2) {
            return ranges
        }

        let cursor = 0
        Array.from(headerRows[0].querySelectorAll('td[role="columnheader"]')).forEach((cell) => {
            let rowSpan = Number(cell.getAttribute('rowspan') || 1)
            let colSpan = Number(cell.getAttribute('colspan') || 1)
            if (rowSpan >= 2) {
                return
            }

            ranges.push({
                start: cursor,
                end: cursor + colSpan - 1,
                label: getHeaderCellText(cell)
            })
            cursor += colSpan
        })

        return ranges
    }

    function getBandLabelForLeafIndex(leafIndex, bandRanges) {
        for (let i = 0; i < bandRanges.length; i++) {
            let band = bandRanges[i]
            if (leafIndex >= band.start && leafIndex <= band.end) {
                return band.label
            }
        }
        return ''
    }

    function buildHeaderMetaById(rootDoc) {
        let metaById = {}
        let headerRows = Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table tr'))
        if (headerRows.length === 0) {
            return metaById
        }

        Array.from(rootDoc.querySelectorAll('.dx-datagrid-headers table td[role="columnheader"][id]')).forEach((cell) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }

            metaById[id] = {
                leafLabel: getHeaderCellText(cell),
                bandLabel: '',
                templateType: getHeaderTemplateType(cell)
            }
        })

        if (headerRows.length < 2) {
            return metaById
        }

        let bandRanges = getHeaderBandRanges(headerRows)
        let leafHeaders = Array.from(
            headerRows[headerRows.length - 1].querySelectorAll('td[role="columnheader"][id]')
        )

        leafHeaders.forEach((cell, leafIndex) => {
            let id = String(cell.getAttribute('id') || '')
            if (!id) {
                return
            }
            if (!metaById[id]) {
                metaById[id] = {
                    leafLabel: getHeaderCellText(cell),
                    bandLabel: '',
                    templateType: getHeaderTemplateType(cell)
                }
            }
            metaById[id].bandLabel = getBandLabelForLeafIndex(leafIndex, bandRanges)
            metaById[id].templateType = getHeaderTemplateType(cell)
        })

        return metaById
    }

    function buildCommentColumnMap(scoreTableEl, rootDoc) {
        let map = {}
        let firstDataRow = Array.from(scoreTableEl.querySelectorAll('tr[aria-rowindex]')).find((rowEl) => {
            return rowEl.querySelector('td[aria-colindex]') !== null
        })
        if (!firstDataRow) {
            return map
        }

        let headerMetaById = buildHeaderMetaById(rootDoc)
        let visibleCols = Array.from(firstDataRow.querySelectorAll('td[aria-colindex]')).map((cell) => {
            let colIndex = String(cell.getAttribute('aria-colindex') || '').trim()
            let headerId = String(cell.getAttribute('aria-describedby') || '').trim()
            let meta = headerMetaById[headerId] || {}
            let leafLabel = normalizeDisplayText(meta.leafLabel || '')
            let bandLabel = normalizeDisplayText(meta.bandLabel || '')
            let templateType = String(meta.templateType || '')
            let isComment = (
                templateType === 'comment' ||
                leafLabel.toLowerCase() === 'cmt' ||
                Boolean(cell.querySelector('.cell-flag.cmt-code'))
            )

            return {
                colIndex: colIndex,
                order: Number(colIndex),
                bandLabel: bandLabel,
                isComment: isComment
            }
        }).filter((column) => column.colIndex)

        let columnsByBand = {}
        visibleCols.forEach((column) => {
            let key = column.bandLabel || ''
            if (!key) {
                return
            }
            if (!columnsByBand[key]) {
                columnsByBand[key] = []
            }
            columnsByBand[key].push(column)
        })

        Object.keys(columnsByBand).forEach((key) => {
            let group = columnsByBand[key]
            let commentCols = group.filter((column) => column.isComment)
            if (commentCols.length === 0) {
                return
            }

            group.forEach((column) => {
                if (column.isComment || map[column.colIndex]) {
                    return
                }

                let match = commentCols
                    .filter((commentCol) => commentCol.order > column.order)
                    .sort((a, b) => a.order - b.order)[0]

                if (!match) {
                    match = commentCols
                        .slice()
                        .sort((a, b) => Math.abs(a.order - column.order) - Math.abs(b.order - column.order))[0]
                }

                if (match) {
                    map[column.colIndex] = match.colIndex
                }
            })
        })

        let sortedCols = visibleCols.slice().sort((a, b) => a.order - b.order)
        sortedCols.forEach((column, index) => {
            if (!column.isComment) {
                return
            }

            for (let leftIndex = index - 1; leftIndex >= 0; leftIndex--) {
                let leftColumn = sortedCols[leftIndex]
                if (leftColumn.isComment) {
                    break
                }
                if (!map[leftColumn.colIndex]) {
                    map[leftColumn.colIndex] = column.colIndex
                }
            }
        })

        return map
    }

    function getEditableScoreInput(cellWrap, targetColIndex) {
        let input = cellWrap.querySelector('input')
        if (input) {
            return input
        }

        cellWrap.click()
        input = cellWrap.querySelector('input')
        if (input) {
            return input
        }

        return null
    }

    function getCellScoreDisplayValue(targetCell) {
        if (!targetCell) {
            return null
        }

        let scoreNode = targetCell.querySelector('.asgn-cell .score')
        if (scoreNode) {
            return normalizeDisplayText(scoreNode.textContent || '')
        }

        let cellNode = targetCell.querySelector('.asgn-cell')
        if (cellNode) {
            let text = normalizeDisplayText(cellNode.textContent || '')
            if (text) {
                return text
            }
        }

        return ''
    }

    function getCellCommentDisplayValue(targetCell) {
        if (!targetCell) {
            return ''
        }

        let commentNode = targetCell.querySelector('.cell-flag.cmt-code')
        return normalizeDisplayText(commentNode ? commentNode.textContent || '' : '')
    }

    function getCellPreviewValue(targetCell, targetRow, targetColIndex, commentColByScoreCol) {
        if (!targetCell) {
            return null
        }

        let cellWrap = targetCell.querySelector('div.asgn-cell-wrap')
        let scoreValue = getCellScoreDisplayValue(targetCell)
        if (cellWrap) {
            let input = getEditableScoreInput(cellWrap, targetColIndex)
            if (input) {
                scoreValue = normalizeDisplayText(input.value || '')
                input.blur()
            }
        }

        let commentValue = ''
        let commentColIndex = String(commentColByScoreCol[String(targetColIndex).trim()] || '').trim()
        if (commentColIndex && targetRow) {
            let commentCell = targetRow.querySelector(`td[aria-colindex="${commentColIndex}"]`)
            commentValue = getCellCommentDisplayValue(commentCell)
        } else {
            commentValue = getCellCommentDisplayValue(targetCell)
        }

        return normalizeDisplayText([scoreValue, commentValue].filter(Boolean).join(' '))
    }

    let wantedCols = Array.isArray(colIndexes)
        ? Array.from(new Set(colIndexes.map((value) => String(value || '').trim()).filter(Boolean)))
        : []

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

    let commentColByScoreCol = buildCommentColumnMap(scoreTable, hostDoc)
    let cellsByStudentId = {}
    scoreTable.querySelectorAll('tr[aria-rowindex]').forEach((rowEl) => {
        let perm = rowEl.querySelector('span.student-perm-id')
        let synergyId = String((perm && perm.textContent) || '').trim()
        if (!synergyId) {
            return
        }

        let rowCells = {}
        wantedCols.forEach((colIndex) => {
            let targetCell = rowEl.querySelector(`td[aria-colindex="${colIndex}"]`)
            if (!targetCell) {
                return
            }
            rowCells[colIndex] = getCellPreviewValue(targetCell, rowEl, colIndex, commentColByScoreCol)
        })
        cellsByStudentId[synergyId] = rowCells
    })

    return {
        ok: true,
        colIndexes: wantedCols,
        cellsByStudentId: cellsByStudentId
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
                let rubric_id = info.menuItemId
                
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
    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "sending_assignments") {
        console.log('Background received a message from popup.js: ' + request.body);
        
        let assignments = request.attachment;
        chrome.storage.local.set({
            'assignments': assignments
        }, () => {
            console.log(`${assignments.length} assignments written to local storage`)
        })
        sendResponse('Thanks for sending! Assignments updated in background')
    }

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "sending_submissions") {
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

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "sending_submissions_bulk") {
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

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "checking_for_assignments") {
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

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "checking_for_submissions") {
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

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "checking_for_submissions_bulk") {
        bg_get_submissions_by_assignment().then((submissions_by_assignment) => {
            sendResponse(submissions_by_assignment)
        })
        return true
    }

    if (request.from == 'popup.js' && request.to == "background.js" && request.title == "clear_data") {
        console.log('Background received a message from popup.js: ' + request.body)
        
        bg_clear_all().then(() => {
            sendResponse('Background cleared storage data and removed contextMenus!')
        })
        
        return true
    }

    if (request.from == 'synergy.js' && request.to == 'background.js' && request.title == 'inject') {
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

    if (request.from == 'synergy.js' && request.to == 'background.js' && request.title == 'inject_batch') {
        chrome.scripting.executeScript({
            world: 'MAIN',
            args: [Array.isArray(request.updates) ? request.updates : []],
            target: { tabId: sender.tab.id },
            func: bg_syn_update_batch
        }).then((injectionResults) => {
            let successfulResult = null
            for (const frameResult of injectionResults) {
                if (frameResult && frameResult.result && frameResult.result.ok) {
                    successfulResult = frameResult.result
                    break
                }
            }
            if (!successfulResult) {
                sendResponse({ ok: false, error: 'Batch injection completed but no editable score cell was updated.' })
                return
            }
            sendResponse({ ok: true, result: successfulResult })
        }).catch((e) => {
            console.log('Batch injection failed:', e)
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
        })
        return true
    }

    if (request.from == 'synergy.js' && request.to == 'background.js' && request.title == 'get_score_table_preview') {
        chrome.scripting.executeScript({
            world: 'MAIN',
            args: [Array.isArray(request.colIndexes) ? request.colIndexes : []],
            target: { tabId: sender.tab.id },
            func: bg_syn_get_score_table_preview
        }).then((injectionResults) => {
            let successfulResult = null
            for (const frameResult of injectionResults) {
                if (frameResult && frameResult.result && frameResult.result.ok) {
                    successfulResult = frameResult.result
                    break
                }
            }
            if (!successfulResult) {
                sendResponse({ ok: false, error: 'Could not inspect visible Synergy score cells.' })
                return
            }
            sendResponse({ ok: true, result: successfulResult })
        }).catch((e) => {
            console.log('Score preview inspection failed:', e)
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
        })
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

if (!chrome.action.onClicked.hasListener(handleActionClick)) {
    chrome.action.onClicked.addListener(handleActionClick)
}

if (!chrome.tabs.onActivated.hasListener(onTabActivated)) {
    chrome.tabs.onActivated.addListener(onTabActivated)
}

if (!chrome.tabs.onUpdated.hasListener(onTabUpdated)) {
    chrome.tabs.onUpdated.addListener(onTabUpdated)
}

if (!chrome.runtime.onInstalled.hasListener(onRuntimeLifecycle)) {
    chrome.runtime.onInstalled.addListener(onRuntimeLifecycle)
}

if (!chrome.runtime.onStartup.hasListener(onRuntimeLifecycle)) {
    chrome.runtime.onStartup.addListener(onRuntimeLifecycle)
}

configureActionForActiveTabs()

addContextListener()

// chrome.runtime.onSuspend.addListener(() => {
//     console.log('Background knows that unload is coming soon... time to disable contextMenus?')
//     chrome.ContextMenus.removeAll()
// })
