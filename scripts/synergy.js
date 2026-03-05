/*
    synergy.js provides:
    1) Existing context-menu paste flow (background -> synergy)
    2) Mapper panel flow for bulk assignment mapping and multi-column paste
*/

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mapperStorageKey = 'synergyColumnMappings'

let mapperState = {
    assignments: [],
    submissionsByAssignment: {},
    roundUpFrom: 0.5,
    missingPref: 'skip',
    mappings: []
}

let mappingRowCounter = 0
let mappingCardCounter = 0
const assignmentMatchThreshold = 0.45
const altMatchThreshold = 0.55
let suppressNextMapperRefresh = false

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array)
    }
}

function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message))
                return
            }
            resolve(response)
        })
    })
}

function getFrameDocument() {
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

    for (let i = 0; i < docs.length; i++) {
        let doc = docs[i]
        try {
            if ($(doc).find('.dx-datagrid-rowsview table').length > 0) {
                return doc
            }
        } catch (docErr) {
            // pass
        }
    }

    for (let i = 0; i < docs.length; i++) {
        let doc = docs[i]
        try {
            if ($(doc).find('.dx-datagrid-headers table').length > 0) {
                return doc
            }
        } catch (docErr) {
            // pass
        }
    }

    try {
        if (document && document.body) {
            return document
        }
    } catch (e) {
        // pass
    }
    return null
}

function getAccessibleDocuments() {
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

    return docs
}

function checkSynergyGradebookPage() {
    let href = String(window.location.href || '')
    if (!href.match(/\/POV_TXP_MAIN\.aspx/i)) {
        return {
            eligible: false,
            reason: 'Not on POV_TXP_MAIN.aspx.'
        }
    }

    let docs = getAccessibleDocuments()
    let pageTitle = ''
    for (let i = 0; i < docs.length; i++) {
        try {
            let titleText = normalizeHeaderText($(docs[i]).find('div.PageTitle').first().text())
            if (titleText) {
                pageTitle = titleText
                break
            }
        } catch (e) {
            // pass inaccessible document
        }
    }

    if (!pageTitle) {
        return {
            eligible: false,
            reason: 'Page title element not found.'
        }
    }

    if (normalizeHeaderText(pageTitle).toLowerCase() !== 'grade book') {
        return {
            eligible: false,
            reason: `Current page is "${pageTitle}", not Grade Book.`
        }
    }

    return {
        eligible: true,
        reason: 'OK'
    }
}

function getSynergyFocusDisplayString(preferredDoc = null) {
    let docs = []
    if (preferredDoc) {
        docs.push(preferredDoc)
    }
    getAccessibleDocuments().forEach((doc) => {
        if (!docs.includes(doc)) {
            docs.push(doc)
        }
    })

    for (let i = 0; i < docs.length; i++) {
        try {
            let focusNode = $(docs[i])
                .find('span[data-bind*="FocusDisplayString"]')
                .filter((_, el) => normalizeHeaderText($(el).text()))
                .first()
            if (focusNode.length > 0) {
                return normalizeHeaderText(focusNode.text())
            }
        } catch (e) {
            // pass inaccessible document
        }
    }

    return ''
}

function getMapperDocument() {
    return getFrameDocument()
}

function mapperQuery(selector) {
    let mapperDoc = getMapperDocument()
    if (!mapperDoc) {
        return $()
    }
    return $(mapperDoc).find(selector)
}

async function waitForMapperDocument(maxAttempts = 20, delayMs = 150) {
    for (let i = 0; i < maxAttempts; i++) {
        let mapperDoc = getMapperDocument()
        if (mapperDoc && mapperDoc.body) {
            return mapperDoc
        }
        await waitFor(delayMs)
    }
    return null
}

function removeMapperFromDocument(doc) {
    if (!doc) {
        return
    }
    try {
        $(doc).find('#bsd-mapper-panel').remove()
        $(doc).find('#bsd-mapper-style').remove()
    } catch (e) {
        console.log('Failed to remove mapper artifacts from document', e)
    }
}

function ensureMapperHostDocument() {
    let frameDoc = getFrameDocument()
    if (frameDoc && frameDoc !== document) {
        // If we now have a usable frame, remove any mapper that may have been created
        // in the top document earlier so we don't leave an invisible duplicate behind.
        removeMapperFromDocument(document)
    }
}

const getRubrics = (assignment) => {
    if (!assignment || !assignment.rubric) {
        return []
    }
    let rubrics = []
    assignment.rubric.forEach((r) => {
        rubrics.push({
            id: String(r.id),
            alt_code: r.description,
            alt_text: r.long_description
        })
    })
    return rubrics
}

const getRubric = (assignment, rubric_id) => {
    let rubric = {}
    getRubrics(assignment).forEach((r) => {
        if (String(r.id) == String(rubric_id)) {
            rubric = r
        }
    })
    return rubric
}

function getAssignmentById(assignments, assign_id) {
    if (!assignments || assignments.length === 0) {
        return null
    }
    let my_assign = null
    assignments.forEach((a) => {
        if (String(a.id) == String(assign_id)) {
            my_assign = a
        }
    })
    return my_assign
}

function getScoresFromSubmissionsByRubricId(submissions, rubric_id) {
    if (!submissions || submissions.length === 0) {
        return []
    }

    let scores = []
    submissions.forEach((s) => {
        let score = {}
        try {
            if ('rubric_assessment' in s) {
                Object.keys(s.rubric_assessment).forEach((r) => {
                    if (String(r) == String(rubric_id)) {
                        let points = ''
                        if (Object.keys(s.rubric_assessment[r]).includes('points')) {
                            points = s.rubric_assessment[r].points
                        }
                        let rubricMissing = points === '' || points == null

                        score = {
                            'synergy_id': s.synergy_id,
                            'rubric_id': String(rubric_id),
                            'score': points,
                            'short_name': s.short_name,
                            'excused': s.excused,
                            'late': s.late,
                            // Treat blank rubric points as missing so Missing/zero preference applies.
                            'missing': Boolean(s.missing || rubricMissing),
                            'course_id': s.course_id,
                            'canvas_id': s.canvas_id,
                            'assign_id': s.assign_id,
                            'grading_per': s.grading_per
                        }
                    }
                })
            } else if (s.excused || s.missing) {
                score = {
                    'synergy_id': s.synergy_id,
                    'rubric_id': String(rubric_id),
                    'score': '',
                    'short_name': s.short_name,
                    'excused': s.excused,
                    'late': s.late,
                    'missing': s.missing,
                    'course_id': s.course_id,
                    'canvas_id': s.canvas_id,
                    'assign_id': s.assign_id,
                    'grading_per': s.grading_per
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

const use_cgr = (scores, roundUpFrom) => {
    let converted = []
    scores.forEach((s) => {
        let copy = { ...s }
        if (copy.score === '') {
            // pass
        } else if (copy.score < 1 + roundUpFrom) {
            copy.score = 'R'
        } else if (copy.score < 2 + roundUpFrom) {
            copy.score = 'G'
        } else if (copy.score >= 2 + roundUpFrom) {
            copy.score = 'CI'
        }
        converted.push(copy)
    })
    return converted
}

// TODO: update late/missing/exc processing
const add_comment_codes_to_score = (score, roundUpFrom, missingPref, use_cgr_flag) => {
    let my_score = score.score
    let rounded_score = ''

    try {
        if (['CI', 'G', 'R', 'N', ''].includes(my_score)) {
            rounded_score = my_score
        } else if (my_score - Math.floor(my_score) < roundUpFrom) {
            rounded_score = Math.floor(my_score)
        } else {
            rounded_score = Math.round(my_score)
        }
    } catch (e) {
        console.log(`${my_score} hit error while rounding`, e)
        rounded_score = my_score
    }

    if (score.excused) {
        return '! ex'
    }

    if (score.missing || rounded_score === 0) {
        switch (missingPref) {
            case 'comment':
                return 'mi !ex'
            case 'score':
                if (use_cgr_flag) return 'R !ex'
                return 'N !ex'
            case 'skip':
                return null
            default:
                return null
        }
    }

    if (score.late) {
        return `${rounded_score} la !ex`
    }

    return `${rounded_score} ! !ex`
}

function synergy_env_ready() {
    let doc = getFrameDocument()
    if (!doc) {
        return false
    }

    let switches = $(doc).find('div.dx-switch-handle')
    if (switches.length < 2) {
        return true
    }

    let readSwitchPosition = (index) => {
        let style = $(switches[index]).attr('style') || ''
        let match = style.match(/\d+/)
        return match ? match[0] : null
    }

    let ready = true
    let grade_detail_default = readSwitchPosition(0) == '100'
    if (!grade_detail_default) {
        ready = false
        try {
            switches[0].click()
        } catch (e) {
            console.log('Unable to click default grade-detail switch', e)
        }
    }

    let grade_detail_off = readSwitchPosition(1) == '0'
    if (!grade_detail_off) {
        ready = false
        try {
            switches[1].click()
        } catch (e) {
            console.log('Unable to click off grade-detail switch', e)
        }
    }

    return ready
}

function getSynergyScoresTable() {
    let doc = getFrameDocument()
    if (!doc) {
        return null
    }
    return $(doc).find('.dx-datagrid-rowsview table').eq(0)
}

function getVisibleSynergyStudentIds(limit = 200) {
    let scoreTable = getSynergyScoresTable()
    if (!scoreTable || scoreTable.length === 0) {
        return []
    }

    let ids = []
    let seen = new Set()

    scoreTable.find('span.student-perm-id').each((_, element) => {
        let id = normalizeHeaderText($(element).text())
        if (!id || seen.has(id)) {
            return
        }

        seen.add(id)
        ids.push(id)
        if (ids.length >= limit) {
            return false
        }
    })

    return ids
}

function normalizeHeaderText(text) {
    if (!text) {
        return ''
    }
    return text
        .replace(/\s+/g, ' ')
        .replace(/[|]+/g, ' ')
        .trim()
}

function cleanSynergyAssignmentLabel(text) {
    let cleaned = normalizeHeaderText(text)
    if (!cleaned) {
        return ''
    }

    cleaned = cleaned
        .replace(/\s*\(\s*\d+\s*\)\s*$/g, '')
        .replace(/\s+due\s*:\s*\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)?/gi, ' ')
        .replace(/\s+pts?\s*:\s*\d+(?:\.\d+)?/gi, ' ')
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?)?\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()

    return cleaned
}

function getHeaderCellText(headerCell) {
    if (!headerCell || headerCell.length === 0) {
        return ''
    }

    let templateType = getHeaderTemplateType(headerCell)
    let assignmentTitle = normalizeHeaderText(headerCell.find('.assignment-title span').first().text())
    if (assignmentTitle) {
        if (templateType === 'assignment' || templateType === 'standards_assignment') {
            return cleanSynergyAssignmentLabel(assignmentTitle)
        }
        return assignmentTitle
    }

    let bandLabel = normalizeHeaderText(headerCell.find('.header-cell.band-cell').first().text())
    if (bandLabel) {
        return cleanSynergyAssignmentLabel(bandLabel)
    }

    let clean = normalizeHeaderText(headerCell.text())
    if (templateType === 'assignment' || templateType === 'standards_assignment') {
        clean = cleanSynergyAssignmentLabel(clean)
    }
    if (clean) {
        return clean
    }

    let ariaLabel = normalizeHeaderText(String(headerCell.attr('aria-label') || ''))
    if (ariaLabel.toLowerCase().startsWith('column ')) {
        ariaLabel = ariaLabel.slice(7).trim()
    }
    return ariaLabel
}

function getHeaderTemplateType(headerCell) {
    if (!headerCell || headerCell.length === 0) {
        return ''
    }

    let options = String(headerCell.find('[data-options*="dxTemplate"]').first().attr('data-options') || '')
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

function detectSynergyViewMode(doc, leafHeaders) {
    let standardsAssignmentCount = 0
    leafHeaders.each((_, cellEl) => {
        let templateType = getHeaderTemplateType($(cellEl))
        if (templateType === 'standards_assignment') {
            standardsAssignmentCount += 1
        }
    })

    if (standardsAssignmentCount > 0) {
        return 'view_by_standard'
    }

    let modeText = normalizeHeaderText($(doc).find('[data-bind*="displayModeButtonConfig"]').first().text()).toLowerCase()
    if (modeText.includes('view by standard')) {
        return 'view_by_standard'
    }
    if (modeText.includes('view by assignment')) {
        return 'view_by_assignment'
    }

    return 'view_by_assignment'
}

function getHeaderBandRanges(headerRows) {
    let ranges = []
    if (!headerRows || headerRows.length < 2) {
        return ranges
    }

    let cursor = 0
    $(headerRows[0]).find('td[role="columnheader"]').each((_, cellEl) => {
        let cell = $(cellEl)
        let rowSpan = Number(cell.attr('rowspan') || 1)
        let colSpan = Number(cell.attr('colspan') || 1)
        if (rowSpan >= 2) {
            return
        }

        let label = getHeaderCellText(cell)
        ranges.push({
            start: cursor,
            end: cursor + colSpan - 1,
            label: label
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

function buildHeaderMetaById(doc) {
    let metaById = {}
    let headerRows = $(doc).find('.dx-datagrid-headers table tr')
    if (headerRows.length === 0) {
        return {
            metaById: metaById,
            viewMode: 'view_by_assignment'
        }
    }

    let leafHeaders = $(headerRows[headerRows.length - 1]).find('td[role="columnheader"][id]')
    let viewMode = detectSynergyViewMode(doc, leafHeaders)

    $(doc).find('.dx-datagrid-headers table td[role="columnheader"][id]').each((_, cellEl) => {
        let cell = $(cellEl)
        let id = String(cell.attr('id') || '')
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
        return {
            metaById: metaById,
            viewMode: viewMode
        }
    }

    let bandRanges = getHeaderBandRanges(headerRows)
    leafHeaders.each((leafIndex, cellEl) => {
        let id = String($(cellEl).attr('id') || '')
        if (!id) {
            return
        }

        if (!metaById[id]) {
            metaById[id] = {
                leafLabel: getHeaderCellText($(cellEl)),
                bandLabel: '',
                templateType: getHeaderTemplateType($(cellEl))
            }
        }
        metaById[id].bandLabel = getBandLabelForLeafIndex(leafIndex, bandRanges)
        metaById[id].templateType = getHeaderTemplateType($(cellEl))
    })

    return {
        metaById: metaById,
        viewMode: viewMode
    }
}

function isExcludedMapperColumnLabel(label) {
    let normalized = normalizeHeaderText(label).toLowerCase()
    if (!normalized) {
        return true
    }
    return ['student name', 'score', 'mark', 'cmt'].includes(normalized)
}

function shouldIncludeCellForMapping(cellEl) {
    let cell = $(cellEl)
    if (!cell.hasClass('dx-editor-cell')) {
        return false
    }

    let gradeBookId = String(cell.attr('data-grade-book-id') || '').trim()
    if (!gradeBookId) {
        return false
    }

    return true
}

function getVisibleSynergyColumns() {
    let doc = getFrameDocument()
    if (!doc) {
        return []
    }

    let scoreTable = getSynergyScoresTable()
    if (!scoreTable || scoreTable.length === 0) {
        return []
    }

    let headerInfo = buildHeaderMetaById(doc)
    let headerMetaById = headerInfo.metaById || {}
    let viewMode = headerInfo.viewMode || 'view_by_assignment'
    let found = new Set()
    let columns = []

    // Use rows-view cells as source of truth for visible leaf columns.
    let firstDataRow = scoreTable.find('tr').filter((_, row) => {
        return $(row).find('td[aria-colindex]').length > 0
    }).first()

    firstDataRow.find('td[aria-colindex]').each((_, element) => {
        let col_index = String($(element).attr('aria-colindex') || '')
        if (!col_index || found.has(col_index)) {
            return
        }
        if (!shouldIncludeCellForMapping(element)) {
            return
        }

        let headerId = String($(element).attr('aria-describedby') || '')
        let meta = headerMetaById[headerId] || {}
        let leafLabel = normalizeHeaderText(meta.leafLabel || '')
        let bandLabel = normalizeHeaderText(meta.bandLabel || '')
        let templateType = String(meta.templateType || '')

        let assignmentLabel = ''
        let altLabel = ''
        if (viewMode === 'view_by_standard') {
            if (templateType !== 'standards_assignment') {
                return
            }
            assignmentLabel = leafLabel || bandLabel || `Column ${col_index}`
            altLabel = bandLabel || leafLabel || assignmentLabel
        } else {
            if (isExcludedMapperColumnLabel(leafLabel)) {
                return
            }
            assignmentLabel = bandLabel || leafLabel || `Column ${col_index}`
            altLabel = leafLabel || assignmentLabel
        }

        if (!assignmentLabel || !altLabel) {
            return
        }

        found.add(col_index)
        let label = assignmentLabel
        if (assignmentLabel !== altLabel) {
            label = `${assignmentLabel} > ${altLabel}`
        }

        columns.push({
            col_index: col_index,
            label: label,
            assignment_label: assignmentLabel,
            alt_label: altLabel,
            header_id: headerId
        })
    })

    columns.sort((a, b) => Number(a.col_index) - Number(b.col_index))
    return columns
}

function getSynergyColumnByIndex(colIndex) {
    let wanted = String(colIndex || '')
    if (!wanted) {
        return null
    }
    let columns = getVisibleSynergyColumns()
    for (let i = 0; i < columns.length; i++) {
        if (String(columns[i].col_index) === wanted) {
            return columns[i]
        }
    }
    return null
}

function getSynergyColumnsByAssignment() {
    let columns = getVisibleSynergyColumns()
    let grouped = {}
    columns.forEach((column) => {
        let assignmentLabel = normalizeHeaderText(column.assignment_label || '')
        if (!assignmentLabel) {
            return
        }
        if (!grouped[assignmentLabel]) {
            grouped[assignmentLabel] = []
        }
        grouped[assignmentLabel].push(column)
    })
    return grouped
}

function normalizeForMatch(text) {
    if (!text) {
        return ''
    }

    return cleanSynergyAssignmentLabel(String(text))
        .toLowerCase()
        .replace(/\(\s*\d+\s*\)/g, ' ')
        .replace(/\bdue\b/g, ' ')
        .replace(/\bpts?\b/g, ' ')
        .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(am|pm)?\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function levenshteinDistance(a, b) {
    let left = String(a || '')
    let right = String(b || '')
    if (left === right) {
        return 0
    }
    if (left.length === 0) {
        return right.length
    }
    if (right.length === 0) {
        return left.length
    }

    let prev = new Array(right.length + 1)
    let curr = new Array(right.length + 1)

    for (let j = 0; j <= right.length; j++) {
        prev[j] = j
    }

    for (let i = 1; i <= left.length; i++) {
        curr[0] = i
        for (let j = 1; j <= right.length; j++) {
            let cost = left[i - 1] === right[j - 1] ? 0 : 1
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost
            )
        }
        for (let j = 0; j <= right.length; j++) {
            prev[j] = curr[j]
        }
    }

    return prev[right.length]
}

function tokenOverlapScore(a, b) {
    let leftTokens = normalizeForMatch(a).split(' ').filter(Boolean)
    let rightTokens = normalizeForMatch(b).split(' ').filter(Boolean)
    if (leftTokens.length === 0 || rightTokens.length === 0) {
        return 0
    }

    let leftSet = new Set(leftTokens)
    let rightSet = new Set(rightTokens)
    let intersection = 0

    leftSet.forEach((token) => {
        if (rightSet.has(token)) {
            intersection += 1
        }
    })

    let union = new Set([...leftSet, ...rightSet]).size
    if (union === 0) {
        return 0
    }
    return intersection / union
}

function similarityScore(a, b) {
    let left = normalizeForMatch(a)
    let right = normalizeForMatch(b)
    if (!left || !right) {
        return 0
    }
    if (left === right) {
        return 1
    }

    let maxLen = Math.max(left.length, right.length)
    let lev = 1 - (levenshteinDistance(left, right) / maxLen)
    let token = tokenOverlapScore(left, right)
    let contains = 0
    if (left.includes(right) || right.includes(left)) {
        contains = Math.min(left.length, right.length) / maxLen
    }
    return Math.max(lev, token, contains)
}

function normalizeTargetCodeToken(token) {
    let compact = String(token || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .trim()
    if (!compact) {
        return ''
    }

    let alphaNumeric = compact.match(/^([A-Z]+)(\d{1,2})$/)
    if (alphaNumeric) {
        return `${alphaNumeric[1]}${alphaNumeric[2].padStart(2, '0')}`
    }
    return compact
}

function extractTargetCodeTokens(text) {
    let source = String(text || '')
        .toUpperCase()
        .replace(/\[\s*\d+\s*\]/g, ' ')
    if (!source) {
        return []
    }

    let tokenSet = new Set()
    let pushToken = (token) => {
        let normalized = normalizeTargetCodeToken(token)
        if (normalized && normalized.length >= 4) {
            tokenSet.add(normalized)
        }
    }

    let dottedMatches = source.match(/[A-Z0-9]+(?:\.[A-Z0-9]+)+/g) || []
    dottedMatches.forEach((dotted) => {
        let parts = dotted
            .split('.')
            .map((part) => part.replace(/[^A-Z0-9]/g, '').trim())
            .filter(Boolean)
        if (parts.length < 2) {
            return
        }

        pushToken(parts.join(''))
        pushToken(parts.slice(-2).join(''))
        if (parts.length >= 3) {
            pushToken(parts.slice(-3).join(''))
        }
    })

    let alphaNumberRegex = /\b([A-Z]{2,})\s*[-_.]?\s*(\d{1,2})\b/g
    let alphaNumberMatch = null
    while ((alphaNumberMatch = alphaNumberRegex.exec(source)) !== null) {
        pushToken(`${alphaNumberMatch[1]}${alphaNumberMatch[2]}`)
    }

    let alphaLetterRegex = /\b([A-Z]{2,})\s*[-_.]?\s*([A-Z])\b/g
    let alphaLetterMatch = null
    while ((alphaLetterMatch = alphaLetterRegex.exec(source)) !== null) {
        pushToken(`${alphaLetterMatch[1]}${alphaLetterMatch[2]}`)
    }

    return Array.from(tokenSet)
}

function targetCodeSimilarityScore(leftText, rightText) {
    let leftTokens = extractTargetCodeTokens(leftText)
    let rightTokens = extractTargetCodeTokens(rightText)
    if (leftTokens.length === 0 || rightTokens.length === 0) {
        return 0
    }

    let rightSet = new Set(rightTokens)
    for (let i = 0; i < leftTokens.length; i++) {
        if (rightSet.has(leftTokens[i])) {
            return 1
        }
    }

    for (let i = 0; i < leftTokens.length; i++) {
        let left = leftTokens[i]
        for (let j = 0; j < rightTokens.length; j++) {
            let right = rightTokens[j]
            if (left.length >= 5 && right.includes(left)) {
                return 0.92
            }
            if (right.length >= 5 && left.includes(right)) {
                return 0.92
            }

            let leftMatch = left.match(/^([A-Z]+)(\d{2})$/)
            let rightMatch = right.match(/^([A-Z]+)(\d{2})$/)
            if (leftMatch && rightMatch && leftMatch[2] === rightMatch[2]) {
                if (leftMatch[1].includes(rightMatch[1]) || rightMatch[1].includes(leftMatch[1])) {
                    return 0.95
                }
            }
        }
    }

    return 0
}

function altSimilarityScore(synergyAlt, rubricText) {
    let base = similarityScore(synergyAlt, rubricText)
    let code = targetCodeSimilarityScore(synergyAlt, rubricText)

    let left = normalizeForMatch(synergyAlt)
    let right = normalizeForMatch(rubricText)
    let contains = 0
    if (left.length >= 5 && right.includes(left)) {
        contains = 0.9
    } else if (right.length >= 5 && left.includes(right)) {
        contains = 0.85
    }

    return Math.max(base, code, contains)
}

function findBestAltMatch(targetAlt, rubrics, threshold = altMatchThreshold) {
    let best = null
    let bestScore = -1

    rubrics.forEach((rubric) => {
        let rubricText = `${rubric.alt_code || ''} ${rubric.alt_text || ''}`.trim()
        let score = altSimilarityScore(targetAlt, rubricText)
        if (score > bestScore) {
            best = rubric
            bestScore = score
        }
    })

    if (!best || bestScore < threshold) {
        return null
    }

    return {
        item: best,
        score: bestScore
    }
}

function findBestMatch(targetText, candidates, getText, threshold = 0.5) {
    let best = null
    let bestScore = -1
    candidates.forEach((candidate) => {
        let candidateText = getText(candidate)
        let score = similarityScore(targetText, candidateText)
        if (score > bestScore) {
            best = candidate
            bestScore = score
        }
    })

    if (!best || bestScore < threshold) {
        return null
    }

    return {
        item: best,
        score: bestScore
    }
}

function getAssignmentUpdatedText(assignment) {
    if (!assignment) {
        return '-'
    }
    let value = assignment.updated_at || assignment.due_at || assignment.created_at
    if (!value) {
        return '-'
    }
    let parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return String(value)
    }
    return parsed.toLocaleString()
}

async function paste_scores_to_column(scores, column_index, roundUpFrom, missingPref, use_cgr_flag) {
    let synergy_scores_table = getSynergyScoresTable()
    if (!synergy_scores_table || synergy_scores_table.length === 0) {
        throw new Error('Synergy score table not found.')
    }

    let col_index = column_index
    if (!col_index) {
        let doc = getFrameDocument()
        col_index = $(doc.activeElement).closest('td').attr('aria-colindex')
    }

    if (!col_index) {
        throw new Error('Could not determine target Synergy column.')
    }

    let prepared_scores = scores.map((s) => ({ ...s }))
    if (use_cgr_flag) {
        prepared_scores = use_cgr(prepared_scores, roundUpFrom)
    }

    prepared_scores.forEach((score) => {
        score.score = add_comment_codes_to_score(score, roundUpFrom, missingPref, use_cgr_flag)
    })

    let scoreById = {}
    prepared_scores.forEach((score) => {
        let scoreId = String(score && score.synergy_id ? score.synergy_id : '').trim()
        if (!scoreId) {
            return
        }
        if (!scoreById[scoreId]) {
            scoreById[scoreId] = score
        }
    })

    let visibleSynergyIds = []
    let visibleSynergyIdSet = new Set()
    let rowIndexByStudentId = {}
    synergy_scores_table.find('span.student-perm-id').each((_, element) => {
        let thisId = String($(element).text() || '').trim()
        if (!thisId || visibleSynergyIdSet.has(thisId)) {
            return
        }
        visibleSynergyIdSet.add(thisId)
        visibleSynergyIds.push(thisId)
        rowIndexByStudentId[thisId] = String($(element).closest('tr').attr('aria-rowindex') || '')
    })

    let outOfScopeScores = 0
    Object.keys(scoreById).forEach((id) => {
        if (!visibleSynergyIdSet.has(id)) {
            outOfScopeScores += 1
        }
    })

    let matched = 0
    let pushed = 0
    let skippedTarget = 0
    let skippedNoCanvasMatch = 0
    let skippedNoPasteValue = 0
    let failedInjection = 0
    let filledNoCanvasMatch = 0
    let pendingInjections = []

    await asyncForEach(visibleSynergyIds, async (id) => {
        let score = scoreById[id]
        let usingFallbackForMissingMatch = false
        if (!score) {
            usingFallbackForMissingMatch = true
            score = {
                score: '',
                late: false,
                excused: false,
                missing: true
            }
            score.score = add_comment_codes_to_score(score, roundUpFrom, missingPref, use_cgr_flag)
        }

        if (score.score == null) {
            skippedTarget++
            if (usingFallbackForMissingMatch) {
                skippedNoCanvasMatch++
            } else {
                skippedNoPasteValue++
            }
            return
        }
        matched++
        if (usingFallbackForMissingMatch) {
            filledNoCanvasMatch++
        }

        let row_index = rowIndexByStudentId[id]

        if (!row_index) {
            skippedTarget++
            failedInjection++
            return
        }

        pendingInjections.push({
            score: score.score,
            late: score.late,
            excused: score.excused,
            missing: score.missing,
            synergy_id: id,
            row: row_index,
            col: String(col_index)
        })
    })

    async function runSequentialInjectionFallback(injections) {
        let fallbackPushed = 0
        let fallbackFailed = 0

        await asyncForEach(injections, async (injection) => {
            let message = {
                to: 'background.js',
                from: 'synergy.js',
                title: 'inject',
                score: injection.score,
                late: injection.late,
                excused: injection.excused,
                missing: injection.missing,
                synergy_id: injection.synergy_id,
                row: injection.row,
                col: injection.col
            }

            try {
                let injectResult = await runtimeSendMessage(message)
                if (!injectResult || injectResult.ok !== true) {
                    let errText = injectResult && injectResult.error ? injectResult.error : 'Unknown injection failure.'
                    throw new Error(errText)
                }
                fallbackPushed++
            } catch (e) {
                console.log(`Failed to inject score for Synergy ID ${injection.synergy_id} in column ${col_index}`, e)
                fallbackFailed++
            }
        })

        return {
            pushed: fallbackPushed,
            failed: fallbackFailed
        }
    }

    if (pendingInjections.length > 0) {
        try {
            let batchMessage = {
                to: 'background.js',
                from: 'synergy.js',
                title: 'inject_batch',
                updates: pendingInjections
            }
            let batchResult = await runtimeSendMessage(batchMessage)
            if (!batchResult || batchResult.ok !== true || !batchResult.result) {
                let errText = batchResult && batchResult.error ? batchResult.error : 'Unknown batch injection failure.'
                throw new Error(errText)
            }

            let updatedCount = Number(batchResult.result.updated_count || 0)
            let failedCount = Number(batchResult.result.failed_count || 0)
            if (!Number.isFinite(updatedCount) || !Number.isFinite(failedCount)) {
                throw new Error('Batch injection returned invalid counters.')
            }

            pushed += Math.max(0, updatedCount)
            failedInjection += Math.max(0, failedCount)
            skippedTarget += Math.max(0, failedCount)
        } catch (e) {
            console.log('Batch injection failed; falling back to sequential injection.', e)
            let fallbackResult = await runSequentialInjectionFallback(pendingInjections)
            pushed += fallbackResult.pushed
            failedInjection += fallbackResult.failed
            skippedTarget += fallbackResult.failed
        }
    }

    return {
        target_total: visibleSynergyIds.length,
        matched: matched,
        pushed: pushed,
        skipped: skippedTarget,
        skipped_target: skippedTarget,
        skipped_no_canvas_match: skippedNoCanvasMatch,
        skipped_no_paste_value: skippedNoPasteValue,
        failed_injection: failedInjection,
        filled_no_canvas_match: filledNoCanvasMatch,
        out_of_scope_scores: outOfScopeScores,
        col_index: String(col_index)
    }
}

async function synergy_paste(scores, roundUpFrom, missingPref, use_cgr_flag) {
    return paste_scores_to_column(scores, null, roundUpFrom, missingPref, use_cgr_flag)
}

function ensureMapperStyles() {
    ensureMapperHostDocument()
    let mapperDoc = getMapperDocument()
    if (!mapperDoc || !mapperDoc.head) {
        return
    }

    if ($(mapperDoc).find('#bsd-mapper-style').length > 0) {
        return
    }

    let style = `
        #bsd-mapper-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            width: min(1120px, calc(100vw - 44px));
            max-height: 78vh;
            overflow: auto;
            z-index: 2147483646;
            background: #20242a;
            color: #ffffff;
            border: 1px solid #4d5968;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.35);
            padding: 12px;
            font-size: 12px;
            font-family: Arial, sans-serif;
        }

        #bsd-mapper-panel h3 {
            margin: 0;
            font-size: 14px;
            cursor: move;
            user-select: none;
        }

        #bsd-mapper-panel .bsd-panel-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }

        #bsd-mapper-panel .bsd-controls {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            margin-bottom: 10px;
        }

        #bsd-mapper-panel button {
            background: #008cff;
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 6px 10px;
            cursor: pointer;
            font-size: 12px;
        }

        #bsd-mapper-panel button:hover {
            background: #2d9fff;
        }

        #bsd-mapper-panel .bsd-close {
            background: #6b2530;
        }

        #bsd-mapper-panel .bsd-close:hover {
            background: #7f2d3a;
        }

        #bsd-mapper-status {
            margin-bottom: 8px;
            color: #b4f7fe;
        }

        #bsd-mapper-panel .bsd-panel-settings {
            display: grid;
            grid-template-columns: 1fr 1fr auto;
            gap: 8px;
            align-items: end;
            margin-bottom: 10px;
        }

        #bsd-mapper-panel .bsd-panel-settings .bsd-save-settings {
            min-height: 28px;
        }

        #bsd-map-cards {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .bsd-map-card {
            border: 1px solid #3b444f;
            border-radius: 6px;
            padding: 8px;
            background: #262d35;
        }

        .bsd-card-grid {
            display: grid;
            grid-template-columns: 1.4fr 1.4fr 1fr auto;
            gap: 8px;
            align-items: end;
            margin-bottom: 8px;
        }

        .bsd-field {
            display: flex;
            flex-direction: column;
            gap: 3px;
            min-width: 0;
        }

        .bsd-field label {
            font-size: 11px;
            color: #8fb2d1;
        }

        .bsd-field select,
        .bsd-field input,
        .bsd-map-row select {
            width: 100%;
            background: #2b3138;
            color: #ffffff;
            border: 1px solid #586473;
            border-radius: 4px;
            min-height: 28px;
        }

        .bsd-canvas-updated {
            min-height: 28px;
            border: 1px solid #586473;
            border-radius: 4px;
            padding: 5px 8px;
            background: #2b3138;
            color: #c6d6e6;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .bsd-card-actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .bsd-alt-columns {
            display: grid;
            grid-template-columns: 1.2fr 1.6fr auto 1fr;
            gap: 6px;
            color: #8fb2d1;
            font-size: 11px;
            margin-bottom: 5px;
            padding: 0 2px;
        }

        .bsd-card-rows {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .bsd-map-row {
            display: grid;
            grid-template-columns: 1.2fr 1.6fr auto 1fr;
            gap: 6px;
            align-items: center;
            border-top: 1px solid #333c46;
            padding-top: 6px;
        }

        .bsd-row-buttons {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .bsd-row-status {
            color: #b4f7fe;
            font-size: 11px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        @media (max-width: 980px) {
            #bsd-mapper-panel .bsd-panel-settings {
                grid-template-columns: 1fr;
            }

            .bsd-card-grid {
                grid-template-columns: 1fr;
            }

            .bsd-card-actions {
                justify-content: flex-start;
            }

            .bsd-alt-columns {
                display: none;
            }

            .bsd-map-row {
                grid-template-columns: 1fr;
            }

            .bsd-row-buttons {
                justify-content: flex-start;
            }
        }
    `

    $(mapperDoc.head).append(`<style id="bsd-mapper-style">${style}</style>`)
}

function ensureMapperPanel() {
    ensureMapperHostDocument()
    let mapperDoc = getMapperDocument()
    if (!mapperDoc || !mapperDoc.body) {
        return
    }

    if ($(mapperDoc).find('#bsd-mapper-panel').length > 0) {
        return
    }

    let panel = `
        <div id="bsd-mapper-panel">
            <div class="bsd-panel-head">
                <h3 id="bsd-panel-drag-handle" title="Drag to move panel">Canvas to Synergy Mapper</h3>
                <button id="bsd-close-panel" class="bsd-close" type="button">Close</button>
            </div>
            <div id="bsd-mapper-status"></div>
            <div class="bsd-panel-settings">
                <div class="bsd-field">
                    <label for="bsd-round-up-from">Round up when decimal is at least</label>
                    <input id="bsd-round-up-from" type="number" min="0.01" max="0.99" step="0.01">
                </div>
                <div class="bsd-field">
                    <label for="bsd-missing-pref">Canvas missing or zero score</label>
                    <select id="bsd-missing-pref">
                        <option value="skip">Skip</option>
                        <option value="comment">Comment (Mi)</option>
                        <option value="score">Score (N/R)</option>
                    </select>
                </div>
                <button id="bsd-save-settings" class="bsd-save-settings" type="button">Save Settings</button>
            </div>
            <div class="bsd-controls">
                <button id="bsd-refresh-data" type="button">Refresh Data</button>
                <button id="bsd-add-mapping" type="button">Add Assignment</button>
                <button id="bsd-auto-match" type="button">Auto-Match</button>
                <button id="bsd-clear-mappings" type="button">Clear</button>
                <button id="bsd-paste-all" type="button">Paste All Mapped</button>
            </div>
            <div id="bsd-map-cards"></div>
        </div>
    `

    $(mapperDoc.body).append(panel)
    attachPanelDragHandlers()

    mapperQuery('#bsd-refresh-data').on('click', async () => {
        await refreshMapperPanel()
    })

    mapperQuery('#bsd-add-mapping').on('click', () => {
        addMapperCard({})
        persistMappingsFromUi()
    })

    mapperQuery('#bsd-auto-match').on('click', () => {
        autoMatchAllMappings(true, true)
    })

    mapperQuery('#bsd-clear-mappings').on('click', () => {
        clearMapperMappings()
    })

    mapperQuery('#bsd-close-panel').on('click', () => {
        closeMapperPanel()
    })

    mapperQuery('#bsd-paste-all').on('click', async () => {
        await pasteAllMappings()
    })

    mapperQuery('#bsd-save-settings').on('click', () => {
        saveMapperSettingsFromUi(true)
    })

    mapperQuery('#bsd-round-up-from').on('change', () => {
        saveMapperSettingsFromUi(false)
    })

    mapperQuery('#bsd-missing-pref').on('change', () => {
        saveMapperSettingsFromUi(false)
    })
}

function normalizeRoundUpFromValue(rawValue, fallback = 0.5) {
    let parsed = Number(rawValue)
    if (!Number.isFinite(parsed)) {
        parsed = Number(fallback)
    }
    if (!Number.isFinite(parsed)) {
        parsed = 0.5
    }

    parsed = Math.max(0.01, Math.min(0.99, parsed))
    return Math.round(parsed * 100) / 100
}

function normalizeMissingPrefValue(rawValue, fallback = 'skip') {
    let value = String(rawValue || fallback || 'skip')
    if (!['skip', 'comment', 'score'].includes(value)) {
        return 'skip'
    }
    return value
}

function getMissingPrefLabel(missingPref) {
    switch (missingPref) {
        case 'comment':
            return 'Comment (Mi)'
        case 'score':
            return 'Score (N/R)'
        case 'skip':
        default:
            return 'Skip'
    }
}

function updateMapperSettingsUiFromState() {
    let roundUpFrom = normalizeRoundUpFromValue(mapperState.roundUpFrom, 0.5)
    let missingPref = normalizeMissingPrefValue(mapperState.missingPref, 'skip')

    mapperState.roundUpFrom = roundUpFrom
    mapperState.missingPref = missingPref

    mapperQuery('#bsd-round-up-from').val(roundUpFrom.toFixed(2))
    mapperQuery('#bsd-missing-pref').val(missingPref)
}

function saveMapperSettingsFromUi(showStatus = false) {
    let roundUpFrom = normalizeRoundUpFromValue(mapperQuery('#bsd-round-up-from').val(), mapperState.roundUpFrom)
    let missingPref = normalizeMissingPrefValue(mapperQuery('#bsd-missing-pref').val(), mapperState.missingPref)

    mapperState.roundUpFrom = roundUpFrom
    mapperState.missingPref = missingPref
    updateMapperSettingsUiFromState()

    chrome.storage.sync.set({
        roundUpFrom: roundUpFrom,
        missingPref: missingPref
    }, () => {
        if (chrome.runtime.lastError) {
            setMapperStatus(`Could not save settings: ${chrome.runtime.lastError.message}`, true)
            return
        }
        if (showStatus) {
            setMapperStatus(`Settings saved. Round-up: ${roundUpFrom.toFixed(2)}. Missing: ${getMissingPrefLabel(missingPref)}.`)
        }
    })
}

function setMapperStatus(text, isError = false) {
    mapperQuery('#bsd-mapper-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function closeMapperPanel() {
    let mapperDoc = getMapperDocument()
    if (!mapperDoc) {
        return
    }
    $(mapperDoc).find('#bsd-mapper-panel').remove()
}

function clearMapperMappings() {
    mapperQuery('#bsd-map-cards').html('')
    mapperState.mappings = []
    suppressNextMapperRefresh = true
    chrome.storage.local.set({ [mapperStorageKey]: [] })
    setMapperStatus('Mappings cleared. Click Add Assignment or Auto-Match.')
}

function attachPanelDragHandlers() {
    let mapperDoc = getMapperDocument()
    if (!mapperDoc) {
        return
    }

    let panel = $(mapperDoc).find('#bsd-mapper-panel')
    let handle = $(mapperDoc).find('#bsd-panel-drag-handle')
    if (panel.length === 0 || handle.length === 0) {
        return
    }

    handle.off('mousedown.bsdMapperDrag').on('mousedown.bsdMapperDrag', (event) => {
        if (event.button !== 0) {
            return
        }

        let panelEl = panel[0]
        let rect = panelEl.getBoundingClientRect()
        let win = mapperDoc.defaultView || window
        let startX = event.clientX
        let startY = event.clientY
        let startLeft = rect.left
        let startTop = rect.top

        panel.css({
            left: `${startLeft}px`,
            top: `${startTop}px`,
            right: 'auto'
        })

        let onMove = (moveEvent) => {
            let dx = moveEvent.clientX - startX
            let dy = moveEvent.clientY - startY

            let panelWidth = panel.outerWidth() || rect.width
            let panelHeight = panel.outerHeight() || rect.height
            let maxLeft = Math.max(0, win.innerWidth - panelWidth)
            let maxTop = Math.max(0, win.innerHeight - panelHeight)

            let left = Math.min(maxLeft, Math.max(0, startLeft + dx))
            let top = Math.min(maxTop, Math.max(0, startTop + dy))

            panel.css({
                left: `${left}px`,
                top: `${top}px`
            })
        }

        let onUp = () => {
            $(mapperDoc).off('mousemove.bsdMapperDrag', onMove)
            $(mapperDoc).off('mouseup.bsdMapperDrag', onUp)
        }

        $(mapperDoc).on('mousemove.bsdMapperDrag', onMove)
        $(mapperDoc).on('mouseup.bsdMapperDrag', onUp)
        event.preventDefault()
    })
}

function getFetchedAssignmentsForMapper() {
    let fetched = mapperState.assignments.filter((assignment) => {
        let key = String(assignment.id)
        let submissions = mapperState.submissionsByAssignment[key]
        return Array.isArray(submissions) && submissions.length > 0
    })
    fetched.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    return fetched
}

function getVisibleSynergyAssignmentNames() {
    return Object.keys(getSynergyColumnsByAssignment()).sort((a, b) => a.localeCompare(b))
}

function resolveSynergyAssignmentName(selectedSynergyAssignment, groupedColumns = null) {
    let grouped = groupedColumns || getSynergyColumnsByAssignment()
    let keys = Object.keys(grouped)
    if (keys.length === 0) {
        return ''
    }

    let raw = cleanSynergyAssignmentLabel(selectedSynergyAssignment || '')
    if (!raw) {
        return ''
    }

    if (grouped[raw]) {
        return raw
    }

    let normalizedRaw = normalizeForMatch(raw)
    if (!normalizedRaw) {
        return ''
    }

    for (let i = 0; i < keys.length; i++) {
        if (normalizeForMatch(keys[i]) === normalizedRaw) {
            return keys[i]
        }
    }

    let fuzzy = findBestMatch(raw, keys, (value) => value, 0.7)
    if (fuzzy && fuzzy.item) {
        return String(fuzzy.item)
    }

    return ''
}

function buildSynergyAssignmentOptions(selectEl, selectedSynergyAssignment) {
    let grouped = getSynergyColumnsByAssignment()
    let assignments = Object.keys(grouped).sort((a, b) => a.localeCompare(b))
    let resolvedSelected = resolveSynergyAssignmentName(selectedSynergyAssignment, grouped)

    selectEl.empty()
    selectEl.append('<option value="">Choose Synergy assignment</option>')
    assignments.forEach((assignmentLabel) => {
        let option = $('<option></option>')
            .attr('value', assignmentLabel)
            .text(assignmentLabel)

        if (resolvedSelected && resolvedSelected === assignmentLabel) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })
}

function buildSynergyAltOptions(selectEl, selectedSynergyAssignment, selectedColIndex) {
    let grouped = getSynergyColumnsByAssignment()
    let resolvedAssignment = resolveSynergyAssignmentName(selectedSynergyAssignment, grouped)
    let columns = []
    if (resolvedAssignment && grouped[resolvedAssignment]) {
        columns = grouped[resolvedAssignment]
    } else if (selectedColIndex) {
        let selectedColumn = getSynergyColumnByIndex(selectedColIndex)
        let columnAssignment = selectedColumn ? resolveSynergyAssignmentName(selectedColumn.assignment_label, grouped) : ''
        if (columnAssignment && grouped[columnAssignment]) {
            columns = grouped[columnAssignment]
        }
    }

    selectEl.empty()
    selectEl.append('<option value="">Choose Synergy ALT</option>')
    columns.forEach((column) => {
        let displayAlt = column.alt_label || column.label || `Column ${column.col_index}`
        let option = $('<option></option>')
            .attr('value', column.col_index)
            .attr('data-alt', displayAlt)
            .text(displayAlt)
        if (String(selectedColIndex) === String(column.col_index)) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })

    let selected = String(selectedColIndex || '')
    let hasSelected = selectEl.find('option').filter((_, optionEl) => String($(optionEl).val()) === selected).length > 0
    if (selected && !hasSelected) {
        selectEl.append(
            $('<option></option>')
                .attr('value', selected)
                .attr('data-alt', `Column ${selected}`)
                .attr('selected', true)
                .text(`[${selected}] Column ${selected}`)
        )
    }
}

function buildCanvasAssignmentOptions(selectEl, selectedAssignId) {
    let assignments = getFetchedAssignmentsForMapper()
    selectEl.empty()
    selectEl.append('<option value="">Choose Canvas assignment</option>')
    assignments.forEach((assignment) => {
        let key = String(assignment.id)
        let option = $('<option></option>')
            .attr('value', key)
            .text(String(assignment.name || key))
        if (String(selectedAssignId) === key) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })

    let selected = String(selectedAssignId || '')
    let hasSelected = selectEl.find('option').filter((_, optionEl) => String($(optionEl).val()) === selected).length > 0
    if (selected && !hasSelected) {
        selectEl.append($('<option></option>').attr('value', selected).attr('selected', true).text(`Assignment ${selected}`))
    }
}

function buildCanvasAltOptions(selectEl, assignmentId, selectedRubricId) {
    selectEl.empty()
    selectEl.append('<option value="">Choose Canvas ALT</option>')
    if (!assignmentId) {
        return
    }

    let assignment = getAssignmentById(mapperState.assignments, assignmentId)
    if (!assignment) {
        return
    }

    let rubrics = getRubrics(assignment)
    rubrics.forEach((rubric) => {
        let option = $('<option></option>')
            .attr('value', String(rubric.id))
            .text(`${rubric.alt_code}${rubric.alt_text ? ` - ${rubric.alt_text}` : ''}`)
        if (String(selectedRubricId) === String(rubric.id)) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })

    let selected = String(selectedRubricId || '')
    let hasSelected = selectEl.find('option').filter((_, optionEl) => String($(optionEl).val()) === selected).length > 0
    if (selected && !hasSelected) {
        selectEl.append($('<option></option>').attr('value', selected).attr('selected', true).text(`Rubric ${selected}`))
    }
}

function updateCanvasUpdatedCell(card, assignmentId) {
    let assignment = getAssignmentById(mapperState.assignments, assignmentId)
    card.find('.bsd-canvas-updated').text(getAssignmentUpdatedText(assignment))
}

function getMapperCards() {
    return mapperQuery('#bsd-map-cards .bsd-map-card')
}

function getRowsForCard(card) {
    return card.find('.bsd-card-rows .bsd-map-row')
}

function getCardFromRow(row) {
    return row.closest('.bsd-map-card')
}

function getCardSynergyAssignment(card) {
    let select = card.find('.bsd-card-syn-assign-select')
    let raw = String(select.val() || '')
    let grouped = getSynergyColumnsByAssignment()
    let resolved = resolveSynergyAssignmentName(raw, grouped)
    if (resolved && resolved !== raw) {
        select.val(resolved)
    }
    return resolved || raw
}

function getCardCanvasAssignment(card) {
    return String(card.find('.bsd-card-canvas-assign-select').val() || '')
}

function getUsedColIndexesForCard(card) {
    let used = new Set()
    getRowsForCard(card).each((_, rowEl) => {
        let value = String($(rowEl).find('.bsd-syn-alt-select').val() || '')
        if (value) {
            used.add(value)
        }
    })
    return used
}

function getSuggestedCardSeed() {
    let grouped = getSynergyColumnsByAssignment()
    let assignmentNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b))
    if (assignmentNames.length === 0) {
        return {}
    }

    let mapped = new Set()
    getMapperCards().each((_, cardEl) => {
        let assignment = getCardSynergyAssignment($(cardEl))
        if (assignment) {
            mapped.add(assignment)
        }
    })

    let suggestedAssignment = assignmentNames[0]
    for (let i = 0; i < assignmentNames.length; i++) {
        if (!mapped.has(assignmentNames[i])) {
            suggestedAssignment = assignmentNames[i]
            break
        }
    }

    let firstColumn = grouped[suggestedAssignment] && grouped[suggestedAssignment][0]
    let rows = []
    if (firstColumn) {
        rows.push({ col_index: String(firstColumn.col_index) })
    }

    return {
        synergy_assignment: suggestedAssignment,
        rows: rows
    }
}

function getSuggestedRowSeedForCard(card) {
    let synergyAssignment = getCardSynergyAssignment(card)
    let grouped = getSynergyColumnsByAssignment()
    let columns = grouped[synergyAssignment] || []
    if (columns.length === 0) {
        return {}
    }

    let usedColIndexes = getUsedColIndexesForCard(card)
    for (let i = 0; i < columns.length; i++) {
        let colIndex = String(columns[i].col_index)
        if (!usedColIndexes.has(colIndex)) {
            return { col_index: colIndex }
        }
    }

    return { col_index: String(columns[0].col_index) }
}

function normalizeCardSeedData(cardData = {}) {
    let safe = cardData || {}
    let selectedCol = String(safe.col_index || '')
    let selectedColumn = selectedCol ? getSynergyColumnByIndex(selectedCol) : null
    let synergyAssignment = cleanSynergyAssignmentLabel(safe.synergy_assignment || (selectedColumn ? selectedColumn.assignment_label : ''))
    let resolvedAssignment = resolveSynergyAssignmentName(synergyAssignment)
    if (resolvedAssignment) {
        synergyAssignment = resolvedAssignment
    }
    let assignmentId = String(safe.assignment_id || '')
    let rows = []

    if (Array.isArray(safe.rows)) {
        safe.rows.forEach((row) => {
            rows.push({
                col_index: String((row && row.col_index) || ''),
                rubric_id: String((row && row.rubric_id) || '')
            })
        })
    } else if (selectedCol || safe.rubric_id) {
        rows.push({
            col_index: selectedCol,
            rubric_id: String(safe.rubric_id || '')
        })
    }

    return {
        synergy_assignment: synergyAssignment,
        assignment_id: assignmentId,
        rows: rows
    }
}

function refreshCardRowSynergyAltOptions(card) {
    let synergyAssignment = getCardSynergyAssignment(card)
    getRowsForCard(card).each((_, rowEl) => {
        let row = $(rowEl)
        let select = row.find('.bsd-syn-alt-select')
        let current = select.val()
        buildSynergyAltOptions(select, synergyAssignment, current)
    })
}

function refreshCardRowCanvasAltOptions(card) {
    let canvasAssignmentId = getCardCanvasAssignment(card)
    getRowsForCard(card).each((_, rowEl) => {
        let row = $(rowEl)
        let select = row.find('.bsd-canvas-alt-select')
        let current = select.val()
        buildCanvasAltOptions(select, canvasAssignmentId, current)
    })
}

function autoMatchCanvasAssignmentForCard(card, force = false) {
    let synergyAssignment = getCardSynergyAssignment(card)
    if (!synergyAssignment) {
        return false
    }

    let canvasAssignSelect = card.find('.bsd-card-canvas-assign-select')
    let currentAssignment = String(canvasAssignSelect.val() || '')
    if (currentAssignment && !force) {
        return false
    }

    let fetchedAssignments = getFetchedAssignmentsForMapper()
    let matched = findBestMatch(
        synergyAssignment,
        fetchedAssignments,
        (assignment) => String(assignment.name || ''),
        assignmentMatchThreshold
    )
    if (!matched || !matched.item) {
        return false
    }

    canvasAssignSelect.val(String(matched.item.id))
    return true
}

function autoMatchCanvasAltForRow(row, force = false) {
    let card = getCardFromRow(row)
    let canvasAssignmentId = getCardCanvasAssignment(card)
    if (!canvasAssignmentId) {
        return false
    }

    let canvasAltSelect = row.find('.bsd-canvas-alt-select')
    let currentCanvasAlt = String(canvasAltSelect.val() || '')
    if (currentCanvasAlt && !force) {
        return false
    }

    let selectedSynAltOption = row.find('.bsd-syn-alt-select option:selected')
    let synergyAlt = String(selectedSynAltOption.attr('data-alt') || selectedSynAltOption.text() || '')
    if (!synergyAlt) {
        return false
    }

    let assignment = getAssignmentById(mapperState.assignments, canvasAssignmentId)
    if (!assignment) {
        return false
    }

    let rubrics = getRubrics(assignment)
    let matched = findBestAltMatch(synergyAlt, rubrics, altMatchThreshold)
    if (!matched || !matched.item) {
        return false
    }

    canvasAltSelect.val(String(matched.item.id))
    return true
}

function autoMatchCardRows(card, force = false) {
    let assignmentMatched = autoMatchCanvasAssignmentForCard(card, force)
    let canvasAssignmentId = getCardCanvasAssignment(card)
    updateCanvasUpdatedCell(card, canvasAssignmentId)
    refreshCardRowCanvasAltOptions(card)

    let altMatched = 0
    getRowsForCard(card).each((_, rowEl) => {
        if (autoMatchCanvasAltForRow($(rowEl), force)) {
            altMatched += 1
        }
    })

    return {
        assignmentMatched: assignmentMatched,
        altMatchedCount: altMatched
    }
}

function ensureCardRowsForAllVisibleSynergyColumns(card) {
    let synergyAssignment = getCardSynergyAssignment(card)
    if (!synergyAssignment) {
        return
    }

    let grouped = getSynergyColumnsByAssignment()
    let columns = grouped[synergyAssignment] || []
    let usedColIndexes = getUsedColIndexesForCard(card)
    columns.forEach((column) => {
        let colIndex = String(column.col_index)
        if (!usedColIndexes.has(colIndex)) {
            createMapperCardRow(card, { col_index: colIndex })
            usedColIndexes.add(colIndex)
        }
    })
}

function autoMatchAllMappings(force = false, showStatus = true) {
    if (force) {
        let grouped = getSynergyColumnsByAssignment()
        let assignmentNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b))
        let existingAssignments = new Set()
        getMapperCards().each((_, cardEl) => {
            let assignment = getCardSynergyAssignment($(cardEl))
            if (assignment) {
                existingAssignments.add(assignment)
            }
        })

        assignmentNames.forEach((assignmentName) => {
            if (existingAssignments.has(assignmentName)) {
                return
            }
            let firstColumn = grouped[assignmentName] && grouped[assignmentName][0]
            let rows = firstColumn ? [{ col_index: String(firstColumn.col_index) }] : []
            createMapperCard({
                synergy_assignment: assignmentName,
                rows: rows
            })
        })

        getMapperCards().each((_, cardEl) => {
            ensureCardRowsForAllVisibleSynergyColumns($(cardEl))
        })
    }

    let cards = getMapperCards()
    if (cards.length === 0) {
        if (showStatus) {
            setMapperStatus('No mapping cards available to auto-match.', true)
        }
        return
    }

    let assignmentMatches = 0
    let altMatches = 0

    cards.each((_, cardEl) => {
        let matchResult = autoMatchCardRows($(cardEl), force)
        if (matchResult.assignmentMatched) {
            assignmentMatches += 1
        }
        altMatches += matchResult.altMatchedCount
    })

    persistMappingsFromUi()
    if (showStatus) {
        setMapperStatus(`Auto-match complete: ${assignmentMatches} assignment(s), ${altMatches} ALT(s).`)
    }
}

function createMapperCardRow(card, rowData = {}) {
    mappingRowCounter += 1
    let selectedCol = String(rowData.col_index || '')
    let canvasAssignmentId = getCardCanvasAssignment(card)

    let row = $(`
        <div class="bsd-map-row" data-row-id="${mappingRowCounter}">
            <select class="bsd-syn-alt-select"></select>
            <select class="bsd-canvas-alt-select"></select>
            <div class="bsd-row-buttons">
                <button class="bsd-row-paste" type="button">Paste</button>
                <button class="bsd-row-remove" type="button">Remove</button>
            </div>
            <span class="bsd-row-status"></span>
        </div>
    `)

    let synAltSelect = row.find('.bsd-syn-alt-select')
    let canvasAltSelect = row.find('.bsd-canvas-alt-select')

    buildSynergyAltOptions(synAltSelect, getCardSynergyAssignment(card), selectedCol)

    if (!synAltSelect.val()) {
        let suggestion = getSuggestedRowSeedForCard(card)
        if (suggestion.col_index) {
            synAltSelect.val(String(suggestion.col_index))
        }
    }

    buildCanvasAltOptions(canvasAltSelect, canvasAssignmentId, rowData.rubric_id)

    synAltSelect.on('change', () => {
        autoMatchCanvasAltForRow(row, false)
        persistMappingsFromUi()
    })

    canvasAltSelect.on('change', () => {
        persistMappingsFromUi()
    })

    row.find('.bsd-row-remove').on('click', () => {
        row.remove()
        if (getRowsForCard(card).length === 0) {
            createMapperCardRow(card, getSuggestedRowSeedForCard(card))
        }
        persistMappingsFromUi()
    })

    row.find('.bsd-row-paste').on('click', async () => {
        await pasteSingleRow(row)
    })

    card.find('.bsd-card-rows').append(row)
    autoMatchCanvasAltForRow(row, false)
}

function createMapperCard(cardData = {}) {
    mappingCardCounter += 1
    let normalized = normalizeCardSeedData(cardData)

    let card = $(`
        <div class="bsd-map-card" data-card-id="${mappingCardCounter}">
            <div class="bsd-card-grid">
                <div class="bsd-field">
                    <label>Synergy Assignment</label>
                    <select class="bsd-card-syn-assign-select"></select>
                </div>
                <div class="bsd-field">
                    <label>Canvas Assignment</label>
                    <select class="bsd-card-canvas-assign-select"></select>
                </div>
                <div class="bsd-field">
                    <label>Canvas Last Updated</label>
                    <div class="bsd-canvas-updated">-</div>
                </div>
                <div class="bsd-card-actions">
                    <button class="bsd-card-add-alt" type="button">Add ALT</button>
                    <button class="bsd-card-paste" type="button">Paste Assignment</button>
                    <button class="bsd-card-remove" type="button">Remove Assignment</button>
                </div>
            </div>
            <div class="bsd-alt-columns">
                <div>Synergy ALT</div>
                <div>Canvas ALT</div>
                <div>Actions</div>
                <div>Status</div>
            </div>
            <div class="bsd-card-rows"></div>
        </div>
    `)

    mapperQuery('#bsd-map-cards').append(card)

    let synAssignSelect = card.find('.bsd-card-syn-assign-select')
    let canvasAssignSelect = card.find('.bsd-card-canvas-assign-select')

    buildSynergyAssignmentOptions(synAssignSelect, normalized.synergy_assignment)
    buildCanvasAssignmentOptions(canvasAssignSelect, normalized.assignment_id)
    updateCanvasUpdatedCell(card, canvasAssignSelect.val())

    synAssignSelect.on('change', () => {
        refreshCardRowSynergyAltOptions(card)
        autoMatchCanvasAssignmentForCard(card, false)
        updateCanvasUpdatedCell(card, getCardCanvasAssignment(card))
        refreshCardRowCanvasAltOptions(card)
        getRowsForCard(card).each((_, rowEl) => {
            autoMatchCanvasAltForRow($(rowEl), false)
        })
        persistMappingsFromUi()
    })

    canvasAssignSelect.on('change', () => {
        updateCanvasUpdatedCell(card, canvasAssignSelect.val())
        refreshCardRowCanvasAltOptions(card)
        getRowsForCard(card).each((_, rowEl) => {
            autoMatchCanvasAltForRow($(rowEl), false)
        })
        persistMappingsFromUi()
    })

    card.find('.bsd-card-add-alt').on('click', () => {
        createMapperCardRow(card, getSuggestedRowSeedForCard(card))
        persistMappingsFromUi()
    })

    card.find('.bsd-card-remove').on('click', () => {
        card.remove()
        persistMappingsFromUi()
    })

    card.find('.bsd-card-paste').on('click', async () => {
        let rows = getRowsForCard(card)
        if (rows.length === 0) {
            setMapperStatus('No ALT rows found for this assignment.', true)
            return
        }

        await loadMapperStateFromStorage()
        for (let i = 0; i < rows.length; i++) {
            await pasteSingleRow($(rows[i]), true)
        }
    })

    let rowSeeds = normalized.rows
    if (rowSeeds.length === 0) {
        rowSeeds = [getSuggestedRowSeedForCard(card)]
    }

    rowSeeds.forEach((rowSeed) => {
        createMapperCardRow(card, rowSeed)
    })

    autoMatchCardRows(card, false)
}

function addMapperCard(cardData = {}) {
    let safeCardData = cardData || {}
    if (Object.keys(safeCardData).length === 0) {
        safeCardData = getSuggestedCardSeed()
    }
    createMapperCard(safeCardData)
}

function buildCardSeedsFromMappings(mappings) {
    if (!Array.isArray(mappings) || mappings.length === 0) {
        return []
    }

    let grouped = {}
    mappings.forEach((mapping) => {
        let colIndex = String(mapping.col_index || '')
        let column = colIndex ? getSynergyColumnByIndex(colIndex) : null
        let derivedAssignment = cleanSynergyAssignmentLabel(mapping.synergy_assignment || (column ? column.assignment_label : ''))
        let resolvedAssignment = resolveSynergyAssignmentName(derivedAssignment)
        if (resolvedAssignment) {
            derivedAssignment = resolvedAssignment
        }
        let groupKey = derivedAssignment || `unassigned_${Object.keys(grouped).length}`

        if (!grouped[groupKey]) {
            grouped[groupKey] = {
                synergy_assignment: derivedAssignment,
                assignment_id: String(mapping.assignment_id || ''),
                rows: []
            }
        }

        if (!grouped[groupKey].assignment_id && mapping.assignment_id) {
            grouped[groupKey].assignment_id = String(mapping.assignment_id)
        }

        grouped[groupKey].rows.push({
            col_index: colIndex,
            rubric_id: String(mapping.rubric_id || '')
        })
    })

    let cards = Object.values(grouped)
    cards.sort((a, b) => String(a.synergy_assignment || '').localeCompare(String(b.synergy_assignment || '')))
    return cards
}

function collectMappingsFromUi() {
    let mappings = []
    getMapperCards().each((_, cardEl) => {
        let card = $(cardEl)
        let synergyAssignment = getCardSynergyAssignment(card)
        let canvasAssignmentId = getCardCanvasAssignment(card)

        getRowsForCard(card).each((_, rowEl) => {
            let row = $(rowEl)
            let selectedSynAltOption = row.find('.bsd-syn-alt-select option:selected')
            mappings.push({
                col_index: row.find('.bsd-syn-alt-select').val(),
                synergy_assignment: synergyAssignment,
                synergy_alt: String(selectedSynAltOption.attr('data-alt') || ''),
                assignment_id: canvasAssignmentId,
                rubric_id: row.find('.bsd-canvas-alt-select').val()
            })
        })
    })
    return mappings
}

function persistMappingsFromUi() {
    let mappings = collectMappingsFromUi()
    mapperState.mappings = mappings
    chrome.storage.local.set({ [mapperStorageKey]: mappings })
}

async function loadMapperStateFromStorage() {
    let local = await chrome.storage.local.get(['assignments', 'submissionsByAssignment', 'submissions', mapperStorageKey])
    let sync = await chrome.storage.sync.get({
        roundUpFrom: 0.5,
        missingPref: 'skip'
    })

    mapperState.assignments = local.assignments || []
    mapperState.submissionsByAssignment = local.submissionsByAssignment || {}

    if (Object.keys(mapperState.submissionsByAssignment).length === 0 && Array.isArray(local.submissions) && local.submissions.length > 0) {
        let fallback_assign_id = String(local.submissions[0].assign_id)
        mapperState.submissionsByAssignment[fallback_assign_id] = local.submissions
    }

    mapperState.roundUpFrom = normalizeRoundUpFromValue(sync.roundUpFrom, 0.5)
    mapperState.missingPref = normalizeMissingPrefValue(sync.missingPref, 'skip')
    mapperState.mappings = Array.isArray(local[mapperStorageKey]) ? local[mapperStorageKey] : []
}

async function refreshMapperPanel() {
    await loadMapperStateFromStorage()
    updateMapperSettingsUiFromState()
    mapperQuery('#bsd-map-cards').html('')
    mappingCardCounter = 0
    mappingRowCounter = 0

    let seeds = buildCardSeedsFromMappings(mapperState.mappings)
    if (seeds.length === 0) {
        addMapperCard({})
    } else {
        seeds.forEach((seed) => addMapperCard(seed))
    }

    autoMatchAllMappings(false, false)

    let fetchedCount = getFetchedAssignmentsForMapper().length
    if (fetchedCount === 0) {
        setMapperStatus('No fetched Canvas assignments found. Open the extension popup on Canvas and run bulk fetch.', true)
    } else {
        setMapperStatus(`Loaded ${fetchedCount} fetched Canvas assignment(s).`)
    }
}

function getMappingFromRow(row) {
    let selectedSynAltOption = row.find('.bsd-syn-alt-select option:selected')
    let card = getCardFromRow(row)
    return {
        col_index: row.find('.bsd-syn-alt-select').val(),
        synergy_assignment: getCardSynergyAssignment(card),
        synergy_alt: String(selectedSynAltOption.attr('data-alt') || ''),
        assignment_id: getCardCanvasAssignment(card),
        rubric_id: row.find('.bsd-canvas-alt-select').val()
    }
}

async function runMappingPaste(mapping) {
    if (!mapping.col_index || !mapping.assignment_id || !mapping.rubric_id) {
        throw new Error('Mapping is incomplete.')
    }

    let assignment = getAssignmentById(mapperState.assignments, mapping.assignment_id)
    if (!assignment) {
        throw new Error('Mapped Canvas assignment was not found.')
    }

    let submissions = mapperState.submissionsByAssignment[String(mapping.assignment_id)] || []
    if (submissions.length === 0) {
        throw new Error('No fetched submissions for selected assignment.')
    }

    let rubric = getRubric(assignment, mapping.rubric_id)
    if (!rubric || !rubric.alt_code) {
        throw new Error('Mapped rubric was not found.')
    }

    let scores = getScoresFromSubmissionsByRubricId(submissions, mapping.rubric_id)
    if (scores.length === 0) {
        throw new Error('No rubric scores found for mapped assignment/rubric. Re-select the Canvas target for this row and try again.')
    }

    if (!synergy_env_ready()) {
        await waitFor(700)
    }
    if (!synergy_env_ready()) {
        throw new Error('Synergy grade detail toggles are not ready yet. Try again.')
    }

    let use_cgr_flag = rubric.alt_code.includes('BLT')
    let result = await paste_scores_to_column(
        scores,
        mapping.col_index,
        mapperState.roundUpFrom,
        mapperState.missingPref,
        use_cgr_flag
    )

    return result
}

async function pasteSingleRow(row, skipReload = false) {
    let status = row.find('.bsd-row-status')
    let mapping = getMappingFromRow(row)

    try {
        if (!skipReload) {
            await loadMapperStateFromStorage()
        }
        status.css('color', '#b4f7fe').text('Pasting...')
        let result = await runMappingPaste(mapping)
        status.css('color', '#b4f7fe').text(`Done: ${result.pushed}/${result.matched} pushed`)
    } catch (e) {
        status.css('color', '#f9b1b1').text(`Error: ${e.message}`)
    }
}

async function pasteAllMappings() {
    let rows = mapperQuery('#bsd-map-cards .bsd-map-row')
    if (rows.length === 0) {
        setMapperStatus('No mapping rows to paste.', true)
        return
    }

    await loadMapperStateFromStorage()
    setMapperStatus(`Pasting ${rows.length} mapping row(s)...`)
    for (let i = 0; i < rows.length; i++) {
        await pasteSingleRow($(rows[i]), true)
    }
    setMapperStatus(`Paste run complete for ${rows.length} mapping row(s).`)
}

function initializeMapperPanel() {
    ;(async () => {
        let mapperDoc = await waitForMapperDocument(40, 100)
        if (!mapperDoc) {
            console.log('Mapper frame document not ready yet; skipping panel init for now')
            return
        }
        ensureMapperStyles()
        ensureMapperPanel()
        refreshMapperPanel()
    })()
}

function myListener(request, sender, sendResponse) {
    console.log(`Message received by synergy.js: from: ${request.from} title: ${request.title}`)

    if (
        request.to == 'synergy.js' &&
        request.title == 'check_gradebook_page' &&
        (request.from == 'popup.js' || request.from == 'sidepanel.js' || request.from == 'background.js')
    ) {
        let check = checkSynergyGradebookPage()
        sendResponse({
            ok: true,
            eligible: check.eligible,
            reason: check.reason
        })
        return false
    }

    if (request.from == 'background.js' && request.to == 'synergy.js' && request.title == 'synergy_paste') {
        let scores = request.attachment || []
        ;(async () => {
            try {
                if (!synergy_env_ready()) {
                    await waitFor(700)
                }
                if (!synergy_env_ready()) {
                    sendResponse('Prepare Synergy env and try again!')
                    return
                }

                let result = await synergy_paste(scores, request.roundUpFrom, request.missingPref, request.use_cgr)
                let statusText = `Synergy paste complete: ${result.pushed}/${result.matched} pushed.`
                let skippedTarget = Number(result && result.skipped_target ? result.skipped_target : 0)
                if (skippedTarget > 0) {
                    statusText += ` ${skippedTarget} skipped in current section.`
                }
                sendResponse(statusText)
            } catch (e) {
                console.log('Synergy paste failed', e)
                sendResponse(`Synergy paste failed: ${e.message}`)
            }
        })()
        return true
    }

    if (request.from == 'popup.js' && request.to == 'synergy.js' && request.title == 'show_mapper_panel') {
        let check = checkSynergyGradebookPage()
        if (!check.eligible) {
            sendResponse(`Mapper unavailable: ${check.reason}`)
            return false
        }
        ;(async () => {
            try {
                let mapperDoc = await waitForMapperDocument(20, 100)
                if (!mapperDoc) {
                    console.log('Mapper frame not ready yet. Refresh Synergy and try again.')
                    return
                }
                ensureMapperStyles()
                ensureMapperPanel()
                await refreshMapperPanel()
            } catch (e) {
                console.log('Failed to show mapper panel from popup request', e)
            }
        })()
        sendResponse('Opening mapper panel...')
        return false
    }

    if (request.from == 'sidepanel.js' && request.to == 'synergy.js' && request.title == 'get_mapper_context') {
        ;(async () => {
            try {
                let check = checkSynergyGradebookPage()
                if (!check.eligible) {
                    sendResponse({
                        ok: false,
                        error: `Mapper unavailable: ${check.reason}`
                    })
                    return
                }

                let mapperDoc = await waitForMapperDocument(20, 100)
                if (!mapperDoc) {
                    sendResponse({
                        ok: false,
                        error: 'Synergy gradebook table not ready yet.'
                    })
                    return
                }

                let headerInfo = buildHeaderMetaById(mapperDoc)
                let columns = getVisibleSynergyColumns()
                let studentIds = getVisibleSynergyStudentIds(200)
                let focusDisplayString = getSynergyFocusDisplayString(mapperDoc)
                sendResponse({
                    ok: true,
                    columns: columns,
                    studentIds: studentIds,
                    viewMode: headerInfo.viewMode || 'view_by_assignment',
                    focusDisplayString: focusDisplayString
                })
            } catch (e) {
                sendResponse({
                    ok: false,
                    error: e && e.message ? e.message : String(e)
                })
            }
        })()
        return true
    }

    if (request.from == 'sidepanel.js' && request.to == 'synergy.js' && request.title == 'paste_mapping') {
        ;(async () => {
            try {
                let check = checkSynergyGradebookPage()
                if (!check.eligible) {
                    sendResponse({
                        ok: false,
                        error: `Mapper unavailable: ${check.reason}`
                    })
                    return
                }

                let mapping = request.mapping || {}
                await loadMapperStateFromStorage()

                if (Object.prototype.hasOwnProperty.call(request, 'roundUpFrom')) {
                    mapperState.roundUpFrom = normalizeRoundUpFromValue(request.roundUpFrom, mapperState.roundUpFrom)
                }
                if (Object.prototype.hasOwnProperty.call(request, 'missingPref')) {
                    mapperState.missingPref = normalizeMissingPrefValue(request.missingPref, mapperState.missingPref)
                }

                let result = await runMappingPaste(mapping)
                sendResponse({
                    ok: true,
                    result: result
                })
            } catch (e) {
                sendResponse({
                    ok: false,
                    error: e && e.message ? e.message : String(e)
                })
            }
        })()
        return true
    }

    return false
}

if (!chrome.runtime.onMessage.hasListener(myListener)) {
    console.log('No listener found by Synergy.js... adding myListener...')
    chrome.runtime.onMessage.addListener(myListener)
} else {
    console.log('Listener already exists! Nothing to do :)')
}

chrome.storage.onChanged.addListener((changes, areaName) => {
    let has_mapper_changes = false
    if (areaName === 'local') {
        has_mapper_changes = Boolean(changes.assignments || changes.submissionsByAssignment || changes[mapperStorageKey])
    }
    if (areaName === 'sync') {
        has_mapper_changes = Boolean(changes.roundUpFrom || changes.missingPref)
    }
    if (has_mapper_changes) {
        if (mapperQuery('#bsd-mapper-panel').length === 0) {
            return
        }
        if (suppressNextMapperRefresh) {
            suppressNextMapperRefresh = false
            return
        }
        refreshMapperPanel()
    }
})
