const mapperStorageKey = 'synergyColumnMappings'
const synergyCanvasMatchStorageKey = 'synergyCanvasCourseMatches'
const mapperSortMethodStorageKey = 'mapperSortMethod'
const canvasAssignmentsByCourseStorageKey = 'canvasAssignmentsByCourse'
const submissionsByAssignmentByCourseStorageKey = 'submissionsByAssignmentByCourse'
const canvasSubmissionSyncByCourseStorageKey = 'canvasSubmissionSyncByCourse'
const defaultMapperSortMethod = 'canvas_recent_desc'
const canvasSubmissionsFetchConcurrency = 6
const assignmentMatchThreshold = 0.45
const altMatchThreshold = 0.55

let mapperState = {
    activeTabId: null,
    activeTabUrl: '',
    synergyStudentIds: [],
    synergyCourseDisplay: '',
    synergyCourseKey: '',
    synergyCanvasCourseMatches: {},
    canvasBaseUrl: '',
    selectedCanvasCourseId: '',
    canvasCourseFilter: '',
    canvasIncludeConcludedCourses: false,
    canvasCourses: [],
    canvasAssignmentsByCourse: {},
    submissionsByAssignmentByCourse: {},
    canvasSubmissionSyncByCourse: {},
    canvasStudentsByCourse: {},
    viewMode: 'view_by_assignment',
    columns: [],
    assignments: [],
    submissionsByAssignment: {},
    roundUpFrom: 0.5,
    missingPref: 'skip',
    sortMethod: defaultMapperSortMethod,
    mappings: []
}

let mappingCardCounter = 0
let mappingRowCounter = 0
let suppressNextMappingsRefresh = false
let suppressLocalRefreshEvents = false
let refreshInFlight = false
let canvasFetchInFlight = false
let canvasFetchController = null
let settingsPersistTimer = null
let clipboardCopyWarningShown = false
let clipboardCopyTooltipHideTimer = null
let canvasCacheTrimmedForQuota = false
let canvasFetchProgressState = {
    total: 0,
    fetched: 0,
    active: 0
}

function setMapperStatus(text, isError = false) {
    $('#bsd-mapper-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function isSynergyUrl(url) {
    return Boolean(
        url &&
        (
            String(url).match(/^https\:\/\/synergy\.beaverton\.k12\.or\.us\//) ||
            String(url).match(/^https\:\/\/syntrn\.beaverton\.k12\.or\.us\//)
        )
    )
}

function isCanvasUrl(url) {
    return Boolean(
        url &&
        String(url).match(/^https\:\/\/[^/]*instructure\.com\//)
    )
}

async function getActiveTab() {
    let tabs = await chrome.tabs.query({ currentWindow: true, active: true })
    if (!tabs || tabs.length === 0) {
        return null
    }
    return tabs[0]
}

async function resolveSynergyTab() {
    let active = await getActiveTab()
    if (active && isSynergyUrl(active.url)) {
        return active
    }

    if (mapperState.activeTabId) {
        try {
            let previous = await chrome.tabs.get(mapperState.activeTabId)
            if (previous && isSynergyUrl(previous.url)) {
                return previous
            }
        } catch (e) {
            // tab no longer available
        }
    }

    return null
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

async function requestSynergyMapperContext(tabId) {
    let response = await sendMessageToTab(tabId, {
        from: 'sidepanel.js',
        to: 'synergy.js',
        title: 'get_mapper_context'
    })

    if (!response || response.ok !== true) {
        let err = response && response.error ? response.error : 'Synergy mapper context is unavailable.'
        throw new Error(err)
    }

    return response
}

function normalizeSynergyId(rawValue) {
    return String(rawValue || '').trim()
}

function normalizeSynergyCourseDisplay(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
}

function extractSynergySectionCode(display) {
    let normalized = normalizeSynergyCourseDisplay(display)
    let match = normalized.match(/\bSEC:\s*([A-Za-z0-9._-]+)/i)
    return match && match[1] ? String(match[1]).toLowerCase() : ''
}

function buildSynergyCourseKeyFromDisplay(display) {
    let normalized = normalizeSynergyCourseDisplay(display)
    let sectionCode = extractSynergySectionCode(normalized)
    if (sectionCode) {
        return `sec:${sectionCode}`
    }

    let normalizedLower = normalized.toLowerCase()
    if (!normalizedLower) {
        return ''
    }

    // Strip grading-period suffix (often after "/") so the key remains stable.
    let beforeSlash = normalizedLower.split('/')[0].trim()
    if (beforeSlash) {
        return `focus:${beforeSlash}`
    }

    return `focus:${normalizedLower}`
}

function buildLegacySynergyCourseKeyFromDisplay(display) {
    let normalized = normalizeSynergyCourseDisplay(display).toLowerCase()
    if (!normalized) {
        return ''
    }
    return `focus:${normalized}`
}

function updateSynergyCourseContextFromResponse(context) {
    let display = normalizeSynergyCourseDisplay(context && context.focusDisplayString ? context.focusDisplayString : '')
    mapperState.synergyCourseDisplay = display
    mapperState.synergyCourseKey = buildSynergyCourseKeyFromDisplay(display)
}

function getStoredCanvasCourseMatchForCurrentSynergyCourse() {
    let key = mapperState.synergyCourseKey
    let display = mapperState.synergyCourseDisplay
    if (!key && !display) {
        return null
    }

    let matches = mapperState.synergyCanvasCourseMatches || {}
    let match = key ? matches[key] : null
    if (!match && display) {
        let legacyKey = buildLegacySynergyCourseKeyFromDisplay(display)
        if (legacyKey) {
            match = matches[legacyKey]
        }
    }
    if (!match && display) {
        let targetSection = extractSynergySectionCode(display)
        if (targetSection) {
            let candidates = Object.values(matches).filter((entry) => {
                if (!entry || !entry.canvasCourseId) {
                    return false
                }
                let section = extractSynergySectionCode(entry.synergyCourseDisplay || '')
                return section && section === targetSection
            })
            if (candidates.length > 0) {
                candidates.sort((a, b) => {
                    let aTime = Date.parse(a.updatedAt || '') || 0
                    let bTime = Date.parse(b.updatedAt || '') || 0
                    return bTime - aTime
                })
                match = candidates[0]
            }
        }
    }
    if (!match || !match.canvasCourseId) {
        return null
    }
    return match
}

function getCanvasCourseNameForId(courseId, courses = null) {
    let wanted = String(courseId || '')
    if (!wanted) {
        return ''
    }
    let list = Array.isArray(courses) ? courses : mapperState.canvasCourses
    let match = list.find((course) => String(course.id) === wanted)
    return match ? String(match && match.name ? match.name : '') : ''
}

async function persistCanvasCourseMatchForCurrentSynergyCourse(canvasCourseId, canvasCourseName = '') {
    let key = mapperState.synergyCourseKey
    if (!key) {
        return
    }

    let matches = { ...(mapperState.synergyCanvasCourseMatches || {}) }
    let normalizedCourseId = String(canvasCourseId || '')
    if (!normalizedCourseId) {
        delete matches[key]
    } else {
        let resolvedName = String(canvasCourseName || getCanvasCourseNameForId(normalizedCourseId) || '').trim()
        matches[key] = {
            synergyCourseDisplay: mapperState.synergyCourseDisplay,
            canvasCourseId: normalizedCourseId,
            canvasCourseName: resolvedName,
            updatedAt: new Date().toISOString()
        }
    }

    mapperState.synergyCanvasCourseMatches = matches
    await chrome.storage.local.set({
        [synergyCanvasMatchStorageKey]: matches
    })
}

function getSynergyStudentIdSet(ids) {
    let set = new Set()
    if (!Array.isArray(ids)) {
        return set
    }
    ids.forEach((id) => {
        let normalized = normalizeSynergyId(id)
        if (normalized) {
            set.add(normalized)
        }
    })
    return set
}

async function getSynergyStudentIdsForCourseFilter() {
    let tab = await resolveSynergyTab()
    if (!tab) {
        mapperState.synergyStudentIds = []
        return []
    }

    mapperState.activeTabId = tab.id
    mapperState.activeTabUrl = tab.url || ''

    let context = await requestSynergyMapperContext(tab.id)
    updateSynergyCourseContextFromResponse(context)
    let ids = Array.isArray(context.studentIds)
        ? context.studentIds.map((id) => normalizeSynergyId(id)).filter(Boolean)
        : []

    mapperState.synergyStudentIds = ids
    return ids
}

async function requestSynergyPaste(tabId, mapping) {
    let response = await sendMessageToTab(tabId, {
        from: 'sidepanel.js',
        to: 'synergy.js',
        title: 'paste_mapping',
        mapping: mapping,
        roundUpFrom: mapperState.roundUpFrom,
        missingPref: mapperState.missingPref
    })

    if (!response || response.ok !== true) {
        let err = response && response.error ? response.error : 'Synergy paste request failed.'
        throw new Error(err)
    }

    return response.result || {}
}

async function copyTextToClipboard(text) {
    let value = String(text || '').trim()
    if (!value) {
        return false
    }

    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value)
            return true
        }
    } catch (e) {
        // fall through to legacy copy path
    }

    try {
        let textarea = document.createElement('textarea')
        textarea.value = value
        textarea.setAttribute('readonly', 'readonly')
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        textarea.style.top = '-9999px'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.focus()
        textarea.select()
        textarea.setSelectionRange(0, textarea.value.length)
        let copied = document.execCommand('copy')
        document.body.removeChild(textarea)
        return Boolean(copied)
    } catch (e) {
        return false
    }
}

function getSelectedCanvasAssignmentLabel(selectEl) {
    let label = normalizeHeaderText(selectEl.find('option:selected').text())
    if (!label || label.toLowerCase() === 'choose canvas assignment') {
        return ''
    }
    return label
}

function getOrCreateClipboardCopyTooltip() {
    let existing = document.getElementById('bsd-copy-tooltip')
    if (existing) {
        return existing
    }

    let root = document.getElementById('bsd-sidepanel') || document.body
    let tooltip = document.createElement('div')
    tooltip.id = 'bsd-copy-tooltip'
    tooltip.className = 'bsd-copy-tooltip'
    tooltip.setAttribute('role', 'status')
    tooltip.setAttribute('aria-live', 'polite')
    root.appendChild(tooltip)
    return tooltip
}

function showClipboardCopyTooltip(anchorEl, message = 'Copied to clipboard') {
    let anchor = anchorEl && anchorEl.length ? anchorEl[0] : anchorEl
    if (!anchor || typeof anchor.getBoundingClientRect !== 'function') {
        return
    }

    let tooltip = getOrCreateClipboardCopyTooltip()
    tooltip.textContent = String(message || 'Copied').trim() || 'Copied'
    tooltip.classList.remove('bsd-visible')

    if (clipboardCopyTooltipHideTimer) {
        window.clearTimeout(clipboardCopyTooltipHideTimer)
        clipboardCopyTooltipHideTimer = null
    }

    let rect = anchor.getBoundingClientRect()
    let margin = 8
    let offset = 8
    let tooltipWidth = tooltip.offsetWidth || 140
    let tooltipHeight = tooltip.offsetHeight || 24
    let left = rect.left + (rect.width / 2) - (tooltipWidth / 2)
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipWidth - margin))
    let top = rect.bottom + offset
    if (top + tooltipHeight + margin > window.innerHeight) {
        top = Math.max(margin, rect.top - tooltipHeight - offset)
    }

    tooltip.style.left = `${Math.round(left)}px`
    tooltip.style.top = `${Math.round(top)}px`
    tooltip.classList.add('bsd-visible')

    clipboardCopyTooltipHideTimer = window.setTimeout(() => {
        tooltip.classList.remove('bsd-visible')
        clipboardCopyTooltipHideTimer = null
    }, 950)
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

function normalizeMapperSortMethod(rawValue, fallback = defaultMapperSortMethod) {
    let value = String(rawValue || fallback || defaultMapperSortMethod)
    let allowed = ['canvas_recent_desc', 'canvas_name_asc', 'synergy_name_asc', 'synergy_order_ltr']
    if (!allowed.includes(value)) {
        return defaultMapperSortMethod
    }
    return value
}

function getMapperSortMethodLabel(sortMethod) {
    switch (normalizeMapperSortMethod(sortMethod)) {
        case 'canvas_name_asc':
            return 'Canvas Assignment A-Z'
        case 'synergy_name_asc':
            return 'Synergy Assignment A-Z'
        case 'synergy_order_ltr':
            return 'Synergy Left-Right'
        case 'canvas_recent_desc':
        default:
            return 'Most Recent First'
    }
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

    $('#bsd-round-up-from').val(roundUpFrom.toFixed(2))
    $('#bsd-missing-pref').val(missingPref)
}

function updateSortControlsFromState() {
    mapperState.sortMethod = normalizeMapperSortMethod(mapperState.sortMethod, defaultMapperSortMethod)
    $('#bsd-sort-method').val(mapperState.sortMethod)
}

function persistSortMethodFromUi() {
    mapperState.sortMethod = normalizeMapperSortMethod($('#bsd-sort-method').val(), mapperState.sortMethod)
    updateSortControlsFromState()
    chrome.storage.local.set({
        [mapperSortMethodStorageKey]: mapperState.sortMethod
    })
}

function persistSettingsFromUi(showStatus = false) {
    mapperState.roundUpFrom = normalizeRoundUpFromValue($('#bsd-round-up-from').val(), mapperState.roundUpFrom)
    mapperState.missingPref = normalizeMissingPrefValue($('#bsd-missing-pref').val(), mapperState.missingPref)
    updateMapperSettingsUiFromState()

    chrome.storage.sync.set({
        roundUpFrom: mapperState.roundUpFrom,
        missingPref: mapperState.missingPref
    }, () => {
        if (chrome.runtime.lastError) {
            setMapperStatus(`Could not save settings: ${chrome.runtime.lastError.message}`, true)
            return
        }
        if (showStatus) {
            setMapperStatus(
                `Settings updated. Round-up: ${mapperState.roundUpFrom.toFixed(2)}. Missing: ${getMissingPrefLabel(mapperState.missingPref)}.`
            )
        }
    })
}

function queuePersistSettingsFromUi(showStatus = false) {
    if (settingsPersistTimer) {
        clearTimeout(settingsPersistTimer)
    }
    settingsPersistTimer = setTimeout(() => {
        settingsPersistTimer = null
        persistSettingsFromUi(showStatus)
    }, 180)
}

function ensurePlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {}
    }
    return value
}

function isQuotaExceededError(error) {
    let message = String(error && error.message ? error.message : error || '')
    return message.toLowerCase().includes('quota')
}

function normalizeRubricAssessmentForCache(rawAssessment) {
    if (!rawAssessment || typeof rawAssessment !== 'object') {
        return null
    }

    let normalized = {}
    Object.keys(rawAssessment).forEach((rubricId) => {
        let criterion = rawAssessment[rubricId]
        if (!criterion || typeof criterion !== 'object') {
            return
        }

        if (Object.prototype.hasOwnProperty.call(criterion, 'points')) {
            normalized[String(rubricId)] = {
                points: criterion.points
            }
        } else {
            normalized[String(rubricId)] = {}
        }
    })

    return Object.keys(normalized).length > 0 ? normalized : null
}

function compactSubmissionForCache(submission) {
    let row = submission && typeof submission === 'object' ? submission : {}
    let compact = {
        course_id: String(row.course_id || ''),
        canvas_id: String(row.canvas_id || ''),
        assign_id: String(row.assign_id || ''),
        synergy_id: String(row.synergy_id || ''),
        short_name: String(row.short_name || ''),
        sortable_name: String(row.sortable_name || ''),
        period: String(row.period || ''),
        posted_at: row.posted_at ? String(row.posted_at) : '',
        excused: Boolean(row.excused),
        late: Boolean(row.late),
        missing: Boolean(row.missing),
        grading_per: row.grading_per == null ? null : row.grading_per
    }

    let rubric = normalizeRubricAssessmentForCache(row.rubric_assessment)
    if (rubric) {
        compact.rubric_assessment = rubric
    }

    return compact
}

function compactSubmissionsForCache(submissions) {
    if (!Array.isArray(submissions)) {
        return []
    }
    return submissions.map((submission) => compactSubmissionForCache(submission))
}

function getNormalizedSubmissionsByAssignmentForAssignments(assignments, source) {
    let list = Array.isArray(assignments) ? assignments : []
    let from = ensurePlainObject(source)
    let normalized = {}

    list.forEach((assignment) => {
        let assignmentId = String(assignment && assignment.id ? assignment.id : '')
        if (!assignmentId) {
            return
        }
        if (Object.prototype.hasOwnProperty.call(from, assignmentId) && Array.isArray(from[assignmentId])) {
            normalized[assignmentId] = compactSubmissionsForCache(from[assignmentId])
        }
    })

    return normalized
}

function getNormalizedSubmissionSyncForAssignments(assignments, source) {
    let list = Array.isArray(assignments) ? assignments : []
    let from = ensurePlainObject(source)
    let normalized = {}

    list.forEach((assignment) => {
        let assignmentId = String(assignment && assignment.id ? assignment.id : '')
        if (!assignmentId) {
            return
        }
        if (Object.prototype.hasOwnProperty.call(from, assignmentId)) {
            normalized[assignmentId] = String(from[assignmentId] || '')
        }
    })

    return normalized
}

function getAssignmentUpdatedAtMap(assignments) {
    let list = Array.isArray(assignments) ? assignments : []
    let map = {}
    list.forEach((assignment) => {
        let assignmentId = String(assignment && assignment.id ? assignment.id : '')
        if (!assignmentId) {
            return
        }
        map[assignmentId] = String(assignment && assignment.updated_at ? assignment.updated_at : '')
    })
    return map
}

function getFirstSubmissionsForAssignments(assignments, submissionsByAssignment) {
    let list = Array.isArray(assignments) ? assignments : []
    let byAssignment = ensurePlainObject(submissionsByAssignment)
    let firstAssignmentId = list.length > 0 ? String(list[0].id || '') : ''
    return firstAssignmentId ? (Array.isArray(byAssignment[firstAssignmentId]) ? byAssignment[firstAssignmentId] : []) : []
}

function getCourseAssignmentsFromCache(courseId) {
    let safeCourseId = String(courseId || '')
    if (!safeCourseId) {
        return []
    }
    let assignments = mapperState.canvasAssignmentsByCourse[safeCourseId]
    return Array.isArray(assignments) ? assignments : []
}

function getCourseSubmissionsByAssignmentFromCache(courseId, assignments = null) {
    let safeCourseId = String(courseId || '')
    if (!safeCourseId) {
        return {}
    }

    let byCourse = ensurePlainObject(mapperState.submissionsByAssignmentByCourse)
    let source = ensurePlainObject(byCourse[safeCourseId])
    let targetAssignments = Array.isArray(assignments) ? assignments : getCourseAssignmentsFromCache(safeCourseId)
    return getNormalizedSubmissionsByAssignmentForAssignments(targetAssignments, source)
}

function getCourseSubmissionSyncMapFromCache(courseId, assignments = null) {
    let safeCourseId = String(courseId || '')
    if (!safeCourseId) {
        return {}
    }

    let byCourse = ensurePlainObject(mapperState.canvasSubmissionSyncByCourse)
    let source = ensurePlainObject(byCourse[safeCourseId])
    let targetAssignments = Array.isArray(assignments) ? assignments : getCourseAssignmentsFromCache(safeCourseId)
    return getNormalizedSubmissionSyncForAssignments(targetAssignments, source)
}

function setActiveCourseDataFromCache(courseId) {
    let safeCourseId = String(courseId || '')
    let assignments = getCourseAssignmentsFromCache(safeCourseId)
    let submissionsByAssignment = getCourseSubmissionsByAssignmentFromCache(safeCourseId, assignments)

    mapperState.selectedCanvasCourseId = safeCourseId
    mapperState.assignments = assignments
    mapperState.submissionsByAssignment = submissionsByAssignment
}

async function persistCanvasCourseCaches(courseId, assignments, submissionsByAssignment, syncMapByAssignment, baseUrl = '') {
    canvasCacheTrimmedForQuota = false
    let safeCourseId = String(courseId || '')
    let safeAssignments = Array.isArray(assignments) ? assignments : []
    let safeSubmissions = getNormalizedSubmissionsByAssignmentForAssignments(safeAssignments, submissionsByAssignment)
    let safeSyncMap = getNormalizedSubmissionSyncForAssignments(safeAssignments, syncMapByAssignment)

    mapperState.canvasAssignmentsByCourse = ensurePlainObject(mapperState.canvasAssignmentsByCourse)
    mapperState.submissionsByAssignmentByCourse = ensurePlainObject(mapperState.submissionsByAssignmentByCourse)
    mapperState.canvasSubmissionSyncByCourse = ensurePlainObject(mapperState.canvasSubmissionSyncByCourse)

    if (safeCourseId) {
        mapperState.canvasAssignmentsByCourse[safeCourseId] = safeAssignments
        mapperState.submissionsByAssignmentByCourse[safeCourseId] = safeSubmissions
        mapperState.canvasSubmissionSyncByCourse[safeCourseId] = safeSyncMap
    }

    setActiveCourseDataFromCache(mapperState.selectedCanvasCourseId || safeCourseId)

    let activeCourseId = String(mapperState.selectedCanvasCourseId || safeCourseId || '')
    let activeAssignments = getCourseAssignmentsFromCache(activeCourseId)
    let activeSubmissionsByAssignment = getCourseSubmissionsByAssignmentFromCache(activeCourseId, activeAssignments)
    let firstSubmissions = getFirstSubmissionsForAssignments(activeAssignments, activeSubmissionsByAssignment)
    let payload = {
        [canvasAssignmentsByCourseStorageKey]: mapperState.canvasAssignmentsByCourse,
        [submissionsByAssignmentByCourseStorageKey]: mapperState.submissionsByAssignmentByCourse,
        [canvasSubmissionSyncByCourseStorageKey]: mapperState.canvasSubmissionSyncByCourse,
        assignments: activeAssignments,
        submissionsByAssignment: activeSubmissionsByAssignment,
        submissions: firstSubmissions,
        canvasCourseId: activeCourseId,
        canvasBaseUrl: String(baseUrl || mapperState.canvasBaseUrl || '')
    }

    try {
        await chrome.storage.local.set(payload)
        return
    } catch (e) {
        if (!isQuotaExceededError(e)) {
            throw e
        }
    }

    // Quota fallback: keep cache only for the active course and retry.
    canvasCacheTrimmedForQuota = true
    let keepCourseId = activeCourseId
    let keepAssignments = getCourseAssignmentsFromCache(keepCourseId)
    let keepSubmissions = getCourseSubmissionsByAssignmentFromCache(keepCourseId, keepAssignments)
    let keepSyncMap = getCourseSubmissionSyncMapFromCache(keepCourseId, keepAssignments)

    mapperState.canvasAssignmentsByCourse = keepCourseId ? { [keepCourseId]: keepAssignments } : {}
    mapperState.submissionsByAssignmentByCourse = keepCourseId ? { [keepCourseId]: keepSubmissions } : {}
    mapperState.canvasSubmissionSyncByCourse = keepCourseId ? { [keepCourseId]: keepSyncMap } : {}
    setActiveCourseDataFromCache(keepCourseId)

    let retryPayload = {
        [canvasAssignmentsByCourseStorageKey]: mapperState.canvasAssignmentsByCourse,
        [submissionsByAssignmentByCourseStorageKey]: mapperState.submissionsByAssignmentByCourse,
        [canvasSubmissionSyncByCourseStorageKey]: mapperState.canvasSubmissionSyncByCourse,
        assignments: mapperState.assignments,
        submissionsByAssignment: mapperState.submissionsByAssignment,
        submissions: getFirstSubmissionsForAssignments(mapperState.assignments, mapperState.submissionsByAssignment),
        canvasCourseId: keepCourseId,
        canvasBaseUrl: String(baseUrl || mapperState.canvasBaseUrl || '')
    }
    await chrome.storage.local.set(retryPayload)
}

async function loadMapperStateFromStorage() {
    let local = await chrome.storage.local.get([
        'assignments',
        'submissionsByAssignment',
        'submissions',
        'canvasBaseUrl',
        'canvasCourseId',
        synergyCanvasMatchStorageKey,
        canvasAssignmentsByCourseStorageKey,
        submissionsByAssignmentByCourseStorageKey,
        canvasSubmissionSyncByCourseStorageKey,
        mapperSortMethodStorageKey,
        mapperStorageKey
    ])
    let sync = await chrome.storage.sync.get({
        roundUpFrom: 0.5,
        missingPref: 'skip'
    })

    mapperState.roundUpFrom = normalizeRoundUpFromValue(sync.roundUpFrom, 0.5)
    mapperState.missingPref = normalizeMissingPrefValue(sync.missingPref, 'skip')
    mapperState.sortMethod = normalizeMapperSortMethod(local[mapperSortMethodStorageKey], defaultMapperSortMethod)
    mapperState.mappings = Array.isArray(local[mapperStorageKey]) ? local[mapperStorageKey] : []
    mapperState.canvasBaseUrl = String(local.canvasBaseUrl || '')
    mapperState.selectedCanvasCourseId = String(local.canvasCourseId || '')
    mapperState.canvasIncludeConcludedCourses = false
    mapperState.canvasAssignmentsByCourse = ensurePlainObject(local[canvasAssignmentsByCourseStorageKey])
    mapperState.submissionsByAssignmentByCourse = ensurePlainObject(local[submissionsByAssignmentByCourseStorageKey])
    mapperState.canvasSubmissionSyncByCourse = ensurePlainObject(local[canvasSubmissionSyncByCourseStorageKey])
    mapperState.synergyCanvasCourseMatches =
        local[synergyCanvasMatchStorageKey] && typeof local[synergyCanvasMatchStorageKey] === 'object'
            ? local[synergyCanvasMatchStorageKey]
            : {}

    let legacyAssignments = Array.isArray(local.assignments) ? local.assignments : []
    let legacySubmissionsByAssignment = ensurePlainObject(local.submissionsByAssignment)
    if (Object.keys(legacySubmissionsByAssignment).length === 0 && Array.isArray(local.submissions) && local.submissions.length > 0) {
        let fallbackAssignId = String(local.submissions[0].assign_id || '')
        if (fallbackAssignId) {
            legacySubmissionsByAssignment[fallbackAssignId] = local.submissions
        }
    }

    let selectedCourseId = mapperState.selectedCanvasCourseId
    if (selectedCourseId) {
        if (!Array.isArray(mapperState.canvasAssignmentsByCourse[selectedCourseId]) && legacyAssignments.length > 0) {
            mapperState.canvasAssignmentsByCourse[selectedCourseId] = legacyAssignments
        }

        let selectedAssignments = getCourseAssignmentsFromCache(selectedCourseId)
        let existingCourseSubmissions = ensurePlainObject(mapperState.submissionsByAssignmentByCourse[selectedCourseId])
        if (Object.keys(existingCourseSubmissions).length === 0 && Object.keys(legacySubmissionsByAssignment).length > 0) {
            mapperState.submissionsByAssignmentByCourse[selectedCourseId] =
                getNormalizedSubmissionsByAssignmentForAssignments(selectedAssignments, legacySubmissionsByAssignment)
        } else {
            mapperState.submissionsByAssignmentByCourse[selectedCourseId] =
                getNormalizedSubmissionsByAssignmentForAssignments(selectedAssignments, existingCourseSubmissions)
        }

        let existingSyncMap = ensurePlainObject(mapperState.canvasSubmissionSyncByCourse[selectedCourseId])
        if (Object.keys(existingSyncMap).length === 0) {
            mapperState.canvasSubmissionSyncByCourse[selectedCourseId] = {}
        } else {
            mapperState.canvasSubmissionSyncByCourse[selectedCourseId] =
                getNormalizedSubmissionSyncForAssignments(selectedAssignments, existingSyncMap)
        }
    }

    setActiveCourseDataFromCache(selectedCourseId)
    if ((!selectedCourseId || mapperState.assignments.length === 0) && legacyAssignments.length > 0) {
        mapperState.assignments = legacyAssignments
        mapperState.submissionsByAssignment =
            getNormalizedSubmissionsByAssignmentForAssignments(legacyAssignments, legacySubmissionsByAssignment)
    }

    updateMapperReadyUi()
}

function setCanvasCourseStatus(text, isError = false) {
    $('#bsd-canvas-course-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function setCanvasFetchStatus(text, isError = false) {
    $('#bsd-canvas-fetch-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function clearCanvasFetchProgress() {
    canvasFetchProgressState = {
        total: 0,
        fetched: 0,
        active: 0
    }
    $('#bsd-canvas-fetch-progress-fetched').css({ width: '0%' })
    $('#bsd-canvas-fetch-progress-active').css({ left: '0%', width: '0%' })
    $('#bsd-canvas-fetch-progress-label').text('')
    $('#bsd-canvas-fetch-progress').addClass('bsd-hidden')
}

function setCanvasFetchProgress(total, fetched = 0, active = 0, label = '') {
    let safeTotal = Math.max(0, Number(total) || 0)
    if (safeTotal <= 0) {
        clearCanvasFetchProgress()
        return
    }

    let safeFetched = Math.max(0, Math.min(safeTotal, Number(fetched) || 0))
    let safeActive = Math.max(0, Math.min(safeTotal - safeFetched, Number(active) || 0))
    let safeRemaining = Math.max(0, safeTotal - safeFetched - safeActive)

    let fetchedPct = (safeFetched / safeTotal) * 100
    let activePct = (safeActive / safeTotal) * 100
    let activeLeftPct = fetchedPct

    canvasFetchProgressState = {
        total: safeTotal,
        fetched: safeFetched,
        active: safeActive
    }

    let defaultLabel = `${safeFetched}/${safeTotal} fetched`
    if (safeActive > 0) {
        defaultLabel += `, ${safeActive} in progress`
    }
    defaultLabel += `, ${safeRemaining} remaining`

    $('#bsd-canvas-fetch-progress-fetched').css({ width: `${fetchedPct}%` })
    $('#bsd-canvas-fetch-progress-active').css({
        left: `${activeLeftPct}%`,
        width: `${activePct}%`
    })
    $('#bsd-canvas-fetch-progress-label').text(String(label || defaultLabel))
    $('#bsd-canvas-fetch-progress').removeClass('bsd-hidden')
}

function isAbortError(error) {
    if (!error) {
        return false
    }
    if (error.name === 'AbortError') {
        return true
    }
    let message = String(error.message || error || '')
    return message.toLowerCase().includes('abort')
}

function updateCanvasActionButtons() {
    let hasCourse = Boolean(String($('#bsd-canvas-course-select').val() || mapperState.selectedCanvasCourseId || ''))

    if (canvasFetchInFlight) {
        $('#bsd-load-canvas-courses').prop('disabled', true)
        $('#bsd-canvas-include-concluded').prop('disabled', true)
        $('#bsd-canvas-course-filter').prop('disabled', true)
        $('#bsd-canvas-course-select').prop('disabled', true)
        $('#bsd-fetch-course-assignments').prop('disabled', true)
        $('#bsd-stop-canvas-fetch').prop('disabled', false)
        return
    }

    $('#bsd-load-canvas-courses').prop('disabled', false)
    $('#bsd-canvas-include-concluded').prop('disabled', false)
    $('#bsd-canvas-course-filter').prop('disabled', false)
    $('#bsd-canvas-course-select').prop('disabled', false)
    $('#bsd-fetch-course-assignments').prop('disabled', !hasCourse)
    $('#bsd-stop-canvas-fetch').prop('disabled', true)
}

function setCanvasControlsDisabled(disabled) {
    canvasFetchInFlight = Boolean(disabled)
    updateCanvasActionButtons()
}

function stopCanvasFetch() {
    if (!canvasFetchInFlight || !canvasFetchController) {
        return
    }
    try {
        canvasFetchController.abort()
        setCanvasCourseStatus('Stopping Canvas fetch...')
        setCanvasFetchStatus('Stopping Canvas fetch...')
    } catch (e) {
        setCanvasCourseStatus('Could not stop fetch cleanly.', true)
        setCanvasFetchStatus('Could not stop fetch cleanly.', true)
    }
}

function beginCanvasFetch(statusText = '', statusChannel = 'course') {
    canvasFetchController = new AbortController()
    setCanvasControlsDisabled(true)
    if (statusChannel === 'fetch') {
        clearCanvasFetchProgress()
    } else {
        clearCanvasFetchProgress()
    }
    if (statusText) {
        if (statusChannel === 'fetch') {
            setCanvasFetchStatus(statusText)
        } else {
            setCanvasCourseStatus(statusText)
            setCanvasFetchStatus('')
        }
    }
}

function endCanvasFetch(statusText = '', isError = false, statusChannel = 'course') {
    canvasFetchController = null
    setCanvasControlsDisabled(false)
    if (statusChannel !== 'fetch') {
        clearCanvasFetchProgress()
    }
    if (statusText) {
        if (statusChannel === 'fetch') {
            setCanvasFetchStatus(statusText, isError)
        } else {
            setCanvasCourseStatus(statusText, isError)
        }
    }
}

function normalizeCanvasBaseUrl(url) {
    let match = String(url || '').match(/^https\:\/\/[^/]*instructure\.com/i)
    return match ? match[0] : ''
}

async function resolveCanvasBaseUrlFromTabs() {
    let tabs = await chrome.tabs.query({})
    if (!Array.isArray(tabs) || tabs.length === 0) {
        return ''
    }

    let preferred = tabs.find((tab) => isCanvasUrl(tab.url) && String(tab.url).match(/\/courses\/\d+\//))
    if (!preferred) {
        preferred = tabs.find((tab) => isCanvasUrl(tab.url))
    }
    if (!preferred) {
        return ''
    }
    return normalizeCanvasBaseUrl(preferred.url)
}

async function ensureCanvasBaseUrl(forceFromTabs = false) {
    if (!forceFromTabs && mapperState.canvasBaseUrl) {
        return mapperState.canvasBaseUrl
    }

    let resolved = await resolveCanvasBaseUrlFromTabs()
    if (!resolved) {
        throw new Error('No Canvas tab found. Open an authenticated Canvas tab and click "Load Courses".')
    }
    mapperState.canvasBaseUrl = resolved
    await chrome.storage.local.set({ canvasBaseUrl: resolved })
    return resolved
}

async function fetchCanvasJson(baseUrl, path) {
    let url = `${baseUrl}${path}`
    let response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        signal: canvasFetchController ? canvasFetchController.signal : undefined
    })

    if (!response.ok) {
        let body = ''
        try {
            body = await response.text()
        } catch (e) {
            // ignore body parsing errors
        }
        let suffix = body ? ` ${String(body).slice(0, 140)}` : ''
        throw new Error(`Canvas API ${response.status} for ${path}.${suffix}`.trim())
    }

    return await response.json()
}

function getCanvasCourseDisplayName(course) {
    if (!course) {
        return ''
    }
    let term = String(course.term_name || '').trim()
    if (term) {
        return `${course.name} (${term})`
    }
    return String(course.name || '')
}

function extractCanvasCourseTermName(course) {
    if (!course || typeof course !== 'object') {
        return ''
    }

    let candidates = [
        course.term_name,
        course.term && course.term.name,
        course.enrollment_term && course.enrollment_term.name,
        course.term && course.term.sis_term_id,
        course.enrollment_term && course.enrollment_term.sis_term_id,
        course.sis_term_id
    ]

    for (let i = 0; i < candidates.length; i++) {
        let value = String(candidates[i] || '').trim()
        if (value) {
            return value
        }
    }

    return ''
}

function normalizeCourseFilterText(value) {
    return String(value || '').trim().toLowerCase()
}

function renderCanvasCourseOptions() {
    let filterInput = $('#bsd-canvas-course-filter')
    let filterRaw = String(filterInput.val() || mapperState.canvasCourseFilter || '')
    let filterText = normalizeCourseFilterText(filterRaw)
    mapperState.canvasCourseFilter = filterRaw

    let filteredCourses = mapperState.canvasCourses.filter((course) => {
        if (!filterText) {
            return true
        }
        return normalizeCourseFilterText(getCanvasCourseDisplayName(course)).includes(filterText)
    })

    let selectedCourseId = String(mapperState.selectedCanvasCourseId || '')
    if (selectedCourseId && !filteredCourses.some((course) => String(course.id) === selectedCourseId)) {
        let selectedCourse = mapperState.canvasCourses.find((course) => String(course.id) === selectedCourseId)
        if (selectedCourse) {
            filteredCourses.unshift(selectedCourse)
        }
    }

    let select = $('#bsd-canvas-course-select')
    select.empty()
    let placeholder = filterText && filteredCourses.length === 0 ? 'No matching course' : 'Choose Canvas course'
    select.append(`<option value="">${placeholder}</option>`)

    filteredCourses.forEach((course) => {
        let option = $('<option></option>')
            .attr('value', String(course.id))
            .text(getCanvasCourseDisplayName(course))
        if (String(course.id) === selectedCourseId) {
            option.attr('selected', true)
        }
        select.append(option)
    })

    updateCanvasActionButtons()
    updateCourseStepUi()
}

function getCachedAssignmentsForSelectedCourse() {
    let courseId = String(mapperState.selectedCanvasCourseId || '')
    if (!courseId) {
        return []
    }
    let assignments = mapperState.canvasAssignmentsByCourse[courseId]
    return Array.isArray(assignments) ? assignments : []
}

function formatCanvasDateTime(value) {
    if (!value) {
        return '-'
    }
    let parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return String(value)
    }
    return parsed.toLocaleString()
}

function getMostRecentPostedAtFromSubmissions(submissions) {
    if (!Array.isArray(submissions) || submissions.length === 0) {
        return ''
    }

    let latestMs = 0
    let latestRaw = ''
    submissions.forEach((submission) => {
        let candidate =
            (submission && submission.posted_at) ||
            (submission && submission.full_object && submission.full_object.posted_at) ||
            ''
        if (!candidate) {
            return
        }
        let parsedMs = Date.parse(String(candidate))
        if (Number.isNaN(parsedMs)) {
            return
        }
        if (!latestRaw || parsedMs > latestMs) {
            latestMs = parsedMs
            latestRaw = String(candidate)
        }
    })

    return latestRaw
}

function getStoredSubmissionsByAssignmentForCourse(assignments) {
    let output = {}
    let incoming = mapperState.submissionsByAssignment || {}
    assignments.forEach((assignment) => {
        let assignmentId = String(assignment.id)
        output[assignmentId] = Array.isArray(incoming[assignmentId]) ? incoming[assignmentId] : []
    })
    return output
}

function renderCanvasAssignmentSummary() {
    let summaryDetails = $('#bsd-canvas-assignment-summary')
    let summaryText = summaryDetails.find('summary')
    let tbody = $('#bsd-canvas-summary-table tbody')
    tbody.empty()

    let assignments = getCachedAssignmentsForSelectedCourse()
    if (assignments.length === 0) {
        summaryText.text('No Canvas assignments loaded yet.')
        tbody.append('<tr><td colspan="3">No assignment data.</td></tr>')
        updateMapperReadyUi()
        return
    }

    let submissionsByAssignment = getStoredSubmissionsByAssignmentForCourse(assignments)
    let fetchedCount = 0
    let totalSubmissions = 0

    assignments.forEach((assignment) => {
        let assignmentId = String(assignment.id)
        let submissions = submissionsByAssignment[assignmentId] || []
        if (submissions.length > 0) {
            fetchedCount += 1
        }
        totalSubmissions += submissions.length

        let mostRecentPostedAt = getMostRecentPostedAtFromSubmissions(submissions)
        let row = $('<tr></tr>')
        row.append($('<td></td>').text(String(assignment.name || assignmentId)))
        row.append($('<td></td>').text(formatCanvasDateTime(mostRecentPostedAt)))
        row.append($('<td></td>').text(String(submissions.length)))
        tbody.append(row)
    })

    summaryText.text(
        `Assignments: ${assignments.length}. With submissions: ${fetchedCount}. Total submissions: ${totalSubmissions}.`
    )
    updateMapperReadyUi()
}

function parseSectionPeriod(sectionName) {
    let match = String(sectionName || '').match(/Per\.\s*(\d+)/i)
    if (!match) {
        return ''
    }
    return String(match[1] || '')
}

function mapStudentsByCanvasId(students) {
    let mapped = {}
    students.forEach((student) => {
        let canvasId = String(student.canvas_id || '')
        if (!canvasId) {
            return
        }
        if (!mapped[canvasId]) {
            mapped[canvasId] = student
        }
    })
    return mapped
}

function addSynergyIdsToSubmissions(submissions, students) {
    let studentsByCanvasId = mapStudentsByCanvasId(students)
    let output = []
    let seen = new Set()
    let unmatched = 0

    submissions.forEach((submission) => {
        let key = String(submission.canvas_id || '')
        if (!key || !studentsByCanvasId[key]) {
            unmatched += 1
            return
        }

        let student = studentsByCanvasId[key]
        if (!student.synergy_id) {
            unmatched += 1
            return
        }

        let enriched = {
            ...submission,
            synergy_id: student.synergy_id,
            short_name: student.short_name,
            sortable_name: student.sortable_name,
            period: student.period
        }

        let dedupeKey = String(enriched.synergy_id || enriched.canvas_id || '')
        if (!dedupeKey || seen.has(dedupeKey)) {
            return
        }
        seen.add(dedupeKey)
        output.push(enriched)
    })

    return {
        submissions: output,
        unmatchedCount: unmatched
    }
}

function getCanvasUserCourseMatchIds(user) {
    let ids = []
    let candidates = [
        user && user.login_id,
        user && user.sis_user_id,
        user && user.integration_id
    ]

    for (let i = 0; i < candidates.length; i++) {
        let normalized = normalizeSynergyId(candidates[i])
        if (normalized) {
            ids.push(normalized)
        }
    }

    return ids
}

async function fetchCanvasStudentSampleForCourse(courseId, baseUrl, sampleSize = 10) {
    let users = await fetchCanvasJson(
        baseUrl,
        `/api/v1/courses/${courseId}/users?enrollment_type[]=student&per_page=${sampleSize}&page=1`
    )

    if (!Array.isArray(users) || users.length === 0) {
        return []
    }

    let sampleIds = []
    let seen = new Set()
    users.forEach((user) => {
        let ids = getCanvasUserCourseMatchIds(user)
        ids.forEach((id) => {
            if (!seen.has(id)) {
                seen.add(id)
                sampleIds.push(id)
            }
        })
    })
    return sampleIds
}

async function filterCanvasCoursesBySynergyRoster(courses, baseUrl, synergyStudentIds) {
    if (!Array.isArray(courses) || courses.length === 0) {
        return []
    }

    let synergyIdSet = getSynergyStudentIdSet(synergyStudentIds)
    if (synergyIdSet.size === 0) {
        return courses
    }

    let matchedCourses = []
    for (let i = 0; i < courses.length; i++) {
        let course = courses[i]
        setCanvasCourseStatus(`Matching course roster ${i + 1}/${courses.length}: ${course.name}`)

        try {
            let sampleIds = await fetchCanvasStudentSampleForCourse(course.id, baseUrl, 10)
            let hasMatch = sampleIds.some((id) => synergyIdSet.has(id))
            if (hasMatch) {
                matchedCourses.push(course)
            }
        } catch (e) {
            if (isAbortError(e)) {
                throw e
            }
            // skip courses we cannot sample and continue matching.
        }
    }

    return matchedCourses
}

async function fetchCanvasCourses(baseUrl, includeConcluded = false) {
    let perPage = 50
    let courses = []
    let states = includeConcluded ? ['active', 'concluded'] : ['active']

    for (let i = 0; i < states.length; i++) {
        let state = states[i]
        let page = 1

        while (true) {
            let stateLabel = state === 'concluded' ? 'concluded courses' : 'active courses'
            setCanvasCourseStatus(`Fetching Canvas ${stateLabel} (page ${page})...`)

            let path = state === 'concluded'
                ? `/api/v1/courses?enrollment_state=concluded&include[]=term&per_page=${perPage}&page=${page}`
                : `/api/v1/courses?enrollment_state=active&state[]=available&include[]=term&per_page=${perPage}&page=${page}`

            let data = await fetchCanvasJson(baseUrl, path)

            if (!Array.isArray(data) || data.length === 0) {
                break
            }

            data.forEach((course) => {
                if (!course || !course.id) {
                    return
                }
                let name = String(course.name || course.course_code || `Course ${course.id}`).trim()
                if (!name) {
                    return
                }
                courses.push({
                    id: String(course.id),
                    name: name,
                    term_name: extractCanvasCourseTermName(course)
                })
            })

            if (data.length < perPage) {
                break
            }
            page += 1
        }
    }

    let dedupe = {}
    courses.forEach((course) => {
        dedupe[String(course.id)] = course
    })

    let output = Object.values(dedupe)
    output.sort((a, b) => {
        let nameCompare = String(a.name || '').localeCompare(String(b.name || ''))
        if (nameCompare !== 0) {
            return nameCompare
        }
        return String(a.term_name || '').localeCompare(String(b.term_name || ''))
    })
    return output
}

async function fetchCanvasAssignmentsForCourse(courseId, baseUrl) {
    let page = 1
    let perPage = 50
    let assignments = []

    while (true) {
        setCanvasCourseStatus(`Fetching assignments (page ${page})...`)
        let data = await fetchCanvasJson(
            baseUrl,
            `/api/v1/courses/${courseId}/assignments?include[]=rubric&order_by=due_at&per_page=${perPage}&page=${page}`
        )

        if (!Array.isArray(data) || data.length === 0) {
            break
        }

        data.forEach((item) => {
            let rubric = Array.isArray(item.rubric) ? item.rubric : []
            let usesRubric = Boolean(item.use_rubric_for_grading || rubric.length > 0)
            let published = item.published !== false
            if (!usesRubric || !published) {
                return
            }

            assignments.push({
                id: String(item.id),
                course_id: String(courseId),
                name: String(item.name || ''),
                use_rubric_for_grading: Boolean(item.use_rubric_for_grading),
                points_possible: item.points_possible,
                rubric: rubric,
                due_at: item.due_at,
                created_at: item.created_at,
                updated_at: item.updated_at
            })
        })

        if (data.length < perPage) {
            break
        }
        page += 1
    }

    assignments.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    return assignments
}

async function fetchCanvasStudentsForCourse(courseId, baseUrl) {
    let cached = mapperState.canvasStudentsByCourse[String(courseId)]
    if (Array.isArray(cached) && cached.length > 0) {
        return cached
    }

    let page = 1
    let perPage = 100
    let students = []
    let dedupe = new Set()

    while (true) {
        setCanvasFetchStatus(`Fetching students (page ${page})...`)
        let sections = await fetchCanvasJson(
            baseUrl,
            `/api/v1/courses/${courseId}/sections?include[]=students&per_page=${perPage}&page=${page}`
        )

        if (!Array.isArray(sections) || sections.length === 0) {
            break
        }

        sections.forEach((section) => {
            let period = parseSectionPeriod(section && section.name ? section.name : '')
            let sectionStudents = Array.isArray(section && section.students) ? section.students : []

            sectionStudents.forEach((student) => {
                let canvasId = String(student && student.id ? student.id : '')
                if (!canvasId || dedupe.has(canvasId)) {
                    return
                }
                dedupe.add(canvasId)

                students.push({
                    canvas_id: canvasId,
                    synergy_id: String(student && student.login_id ? student.login_id : ''),
                    short_name: String(student && student.short_name ? student.short_name : ''),
                    sortable_name: String(student && student.sortable_name ? student.sortable_name : ''),
                    period: period
                })
            })
        })

        if (sections.length < perPage) {
            break
        }
        page += 1
    }

    mapperState.canvasStudentsByCourse[String(courseId)] = students
    return students
}

async function fetchCanvasSubmissionsForAssignment(courseId, assignment, students, baseUrl, options = {}) {
    let showStatus = options.showStatus !== false
    let page = 1
    let perPage = 50
    let submissions = []

    while (true) {
        if (showStatus) {
            setCanvasFetchStatus(`Fetching submissions: ${assignment.name} (page ${page})...`)
        }
        let data = await fetchCanvasJson(
            baseUrl,
            `/api/v1/courses/${courseId}/assignments/${assignment.id}/submissions?include[]=rubric_assessment&per_page=${perPage}&page=${page}`
        )

        if (!Array.isArray(data) || data.length === 0) {
            break
        }

        data.forEach((item) => {
            let row = {
                course_id: String(courseId),
                canvas_id: String(item && item.user_id ? item.user_id : ''),
                assign_id: String(assignment.id),
                posted_at: item ? item.posted_at : null,
                excused: Boolean(item && item.excused),
                late: Boolean(item && item.late),
                missing: Boolean(item && item.missing),
                grading_per: item ? item.grading_period_id : null
            }

            let rubricAssessment = normalizeRubricAssessmentForCache(item ? item.rubric_assessment : null)
            if (rubricAssessment) {
                row.rubric_assessment = rubricAssessment
            }

            submissions.push(row)
        })

        if (data.length < perPage) {
            break
        }
        page += 1
    }

    let result = addSynergyIdsToSubmissions(submissions, students)
    return {
        submissions: compactSubmissionsForCache(result.submissions),
        unmatchedCount: result.unmatchedCount
    }
}

async function loadCanvasCourses(forceFromTabs = false, options = {}) {
    if (canvasFetchInFlight) {
        return
    }

    beginCanvasFetch('Connecting to Canvas...', 'course')
    try {
        let resetSelectedCourse = Boolean(options && options.resetSelectedCourse === true)
        let previousSelectedCourseId = String(mapperState.selectedCanvasCourseId || '')
        if (resetSelectedCourse) {
            mapperState.selectedCanvasCourseId = ''
        }
        let includeConcluded = Boolean($('#bsd-canvas-include-concluded').prop('checked') || mapperState.canvasIncludeConcludedCourses)
        mapperState.canvasIncludeConcludedCourses = includeConcluded

        let baseUrl = await ensureCanvasBaseUrl(forceFromTabs)
        let allCourses = await fetchCanvasCourses(baseUrl, includeConcluded)
        let courses = allCourses
        let rosterFilterApplied = false
        let usedStoredMatch = false

        let synergyStudentIds = []
        try {
            synergyStudentIds = await getSynergyStudentIdsForCourseFilter()
        } catch (e) {
            synergyStudentIds = []
        }

        let storedMatch = getStoredCanvasCourseMatchForCurrentSynergyCourse()
        let storedCanvasCourseId = String(storedMatch && storedMatch.canvasCourseId ? storedMatch.canvasCourseId : '')
        if (storedCanvasCourseId) {
            usedStoredMatch = true
        }

        if (synergyStudentIds.length > 0 && !usedStoredMatch) {
            rosterFilterApplied = true
            courses = await filterCanvasCoursesBySynergyRoster(allCourses, baseUrl, synergyStudentIds)
        } else if (synergyStudentIds.length > 0 && usedStoredMatch) {
            let storedExists = allCourses.some((course) => String(course.id) === storedCanvasCourseId)
            if (!storedExists) {
                usedStoredMatch = false
                rosterFilterApplied = true
                courses = await filterCanvasCoursesBySynergyRoster(allCourses, baseUrl, synergyStudentIds)
            }
        }

        mapperState.canvasCourses = courses

        let selectedFromStoredMatch = ''
        if (usedStoredMatch && storedCanvasCourseId && courses.some((course) => String(course.id) === storedCanvasCourseId)) {
            selectedFromStoredMatch = storedCanvasCourseId
        }
        if (selectedFromStoredMatch) {
            mapperState.selectedCanvasCourseId = selectedFromStoredMatch
        } else if (
            !mapperState.selectedCanvasCourseId ||
            !courses.find((course) => String(course.id) === String(mapperState.selectedCanvasCourseId))
        ) {
            mapperState.selectedCanvasCourseId = courses.length > 0 ? String(courses[0].id) : ''
        }

        if (String(mapperState.selectedCanvasCourseId || '') !== previousSelectedCourseId) {
            await clearMapperDataForCourseChange(mapperState.selectedCanvasCourseId)
        }

        renderCanvasCourseOptions()
        if (mapperState.selectedCanvasCourseId) {
            let summary = await loadCanvasAssignmentsForSelectedCourse({
                courseId: mapperState.selectedCanvasCourseId,
                manageLoading: false,
                forceRefresh: false,
                throwOnError: true
            })
            let assignmentText = summary ? ` Loaded ${summary.assignmentsCount} assignment(s).` : ''
            let scopeText = includeConcluded ? ' (including archived).' : '.'
            let filterText = ''
            if (usedStoredMatch && selectedFromStoredMatch) {
                let storedCanvasName = storedMatch && storedMatch.canvasCourseName
                    ? storedMatch.canvasCourseName
                    : getCanvasCourseNameForId(selectedFromStoredMatch, courses)
                let nameSuffix = storedCanvasName ? ` (${storedCanvasName})` : ''
                filterText = ` Restored saved Canvas match for this Synergy class${nameSuffix}.`
            } else if (rosterFilterApplied) {
                filterText = ` Matched ${courses.length}/${allCourses.length} course(s) to current Synergy roster sample.`
            } else if (allCourses.length > 0) {
                filterText = ' Synergy roster matching unavailable; showing all Canvas courses.'
            }
            endCanvasFetch(`Loaded ${courses.length} Canvas course(s)${scopeText}${assignmentText}${filterText}`, false, 'course')
        } else {
            mapperState.selectedCanvasCourseId = ''
            await chrome.storage.local.set({
                canvasCourseId: '',
                assignments: [],
                submissionsByAssignment: {},
                submissions: []
            })
            await loadMapperStateFromStorage()
            renderCanvasAssignmentSummary()
            updateMapperReadyUi()

            let noCoursesText = includeConcluded ? 'No active or archived Canvas courses found.' : 'No active Canvas courses found.'
            if (allCourses.length > 0 && rosterFilterApplied) {
                noCoursesText = 'No Canvas courses matched at least one student from the current Synergy class sample.'
            }
            endCanvasFetch(noCoursesText, true, 'course')
        }
    } catch (e) {
        renderCanvasCourseOptions()
        renderCanvasAssignmentSummary()
        updateMapperReadyUi()
        if (isAbortError(e)) {
            endCanvasFetch('Canvas fetch stopped by user.', false, 'course')
            return
        }
        endCanvasFetch(`Canvas course load failed: ${e.message}`, true, 'course')
    }
}

async function loadCanvasAssignmentsForSelectedCourse(options = {}) {
    let selectedCourseId = String(options.courseId || $('#bsd-canvas-course-select').val() || mapperState.selectedCanvasCourseId || '')
    let manageLoading = options.manageLoading === true
    let forceRefresh = options.forceRefresh === true
    let throwOnError = options.throwOnError === true

    mapperState.selectedCanvasCourseId = selectedCourseId
    await chrome.storage.local.set({ canvasCourseId: selectedCourseId })
    $('#bsd-canvas-course-select').val(selectedCourseId)
    updateCanvasActionButtons()

    if (!selectedCourseId) {
        renderCanvasAssignmentSummary()
        if (manageLoading) {
            endCanvasFetch('Select a Canvas course first.', true, 'course')
        } else {
            setCanvasCourseStatus('Select a Canvas course first.', true)
        }
        return null
    }

    if (manageLoading) {
        beginCanvasFetch('Loading assignment list for selected course...', 'course')
    }

    try {
        let baseUrl = await ensureCanvasBaseUrl(false)
        let assignments = getCourseAssignmentsFromCache(selectedCourseId)
        if (forceRefresh || !Array.isArray(assignments) || assignments.length === 0) {
            assignments = await fetchCanvasAssignmentsForCourse(selectedCourseId, baseUrl)
        }
        assignments = Array.isArray(assignments) ? assignments : []
        let submissionsByAssignment = getCourseSubmissionsByAssignmentFromCache(selectedCourseId, assignments)
        let submissionSyncMap = getCourseSubmissionSyncMapFromCache(selectedCourseId, assignments)
        await persistCanvasCourseCaches(selectedCourseId, assignments, submissionsByAssignment, submissionSyncMap, baseUrl)

        await loadMapperStateFromStorage()
        renderCanvasAssignmentSummary()
        updateCanvasActionButtons()

        let loadedText = `Loaded ${assignments.length} assignment(s). Click "Fetch Canvas Scores" to pull submissions.`
        if (canvasCacheTrimmedForQuota) {
            loadedText += ' Cache trimmed to current course due to storage limits.'
        }
        if (manageLoading) {
            endCanvasFetch(loadedText, false, 'course')
        } else {
            setCanvasCourseStatus(loadedText)
        }

        return {
            assignmentsCount: assignments.length
        }
    } catch (e) {
        renderCanvasAssignmentSummary()
        if (throwOnError) {
            throw e
        }
        if (isAbortError(e)) {
            if (manageLoading) {
                endCanvasFetch('Canvas fetch stopped by user.', false, 'course')
            } else {
                setCanvasCourseStatus('Canvas fetch stopped by user.')
            }
            return null
        }

        if (manageLoading) {
            endCanvasFetch(`Assignment load failed: ${e.message}`, true, 'course')
        } else {
            setCanvasCourseStatus(`Assignment load failed: ${e.message}`, true)
        }
        return null
    }
}

async function fetchAllCanvasDataForCourse(courseId, options = {}) {
    let manageLoading = options.manageLoading !== false
    let forceAssignmentsRefresh = options.forceAssignmentsRefresh === true
    let selectedCourseId = String(courseId || mapperState.selectedCanvasCourseId || '')

    if (!selectedCourseId) {
        renderCanvasAssignmentSummary()
        if (manageLoading) {
            endCanvasFetch('Select a Canvas course first.', true, 'fetch')
        } else {
            setCanvasFetchStatus('Select a Canvas course first.', true)
        }
        return null
    }

    mapperState.selectedCanvasCourseId = selectedCourseId
    await chrome.storage.local.set({ canvasCourseId: selectedCourseId })
    await persistCanvasCourseMatchForCurrentSynergyCourse(
        selectedCourseId,
        getCanvasCourseNameForId(selectedCourseId)
    )
    $('#bsd-canvas-course-select').val(selectedCourseId)
    updateCanvasActionButtons()

    if (manageLoading) {
        beginCanvasFetch('Fetching all course assignments and submissions...', 'fetch')
    }

    try {
        await loadCanvasAssignmentsForSelectedCourse({
            courseId: selectedCourseId,
            manageLoading: false,
            // Refresh assignment metadata every fetch so updated_at comparison stays current.
            forceRefresh: true,
            throwOnError: true
        })

        let assignments = getCourseAssignmentsFromCache(selectedCourseId)
        assignments = Array.isArray(assignments) ? assignments : []
        let cachedSubmissionsByAssignment = getCourseSubmissionsByAssignmentFromCache(selectedCourseId, assignments)
        let cachedSubmissionSyncMap = getCourseSubmissionSyncMapFromCache(selectedCourseId, assignments)

        if (assignments.length === 0) {
            clearCanvasFetchProgress()
            await persistCanvasCourseCaches(selectedCourseId, [], {}, {}, mapperState.canvasBaseUrl)
            await loadMapperStateFromStorage()
            renderCanvasAssignmentSummary()
            let emptyMessage = 'No rubric-enabled published assignments found in selected course.'
            if (manageLoading) {
                endCanvasFetch(emptyMessage, false, 'fetch')
            } else {
                setCanvasFetchStatus(emptyMessage)
            }
            return {
                assignmentsCount: 0,
                unmatchedCount: 0
            }
        }

        let assignmentUpdatedAtMap = getAssignmentUpdatedAtMap(assignments)
        let assignmentsToFetch = []
        assignments.forEach((assignment) => {
            let assignmentId = String(assignment && assignment.id ? assignment.id : '')
            if (!assignmentId) {
                return
            }
            let hasSyncToken = Object.prototype.hasOwnProperty.call(cachedSubmissionSyncMap, assignmentId)
            let lastSyncedUpdatedAt = String(cachedSubmissionSyncMap[assignmentId] || '')
            let latestUpdatedAt = String(assignmentUpdatedAtMap[assignmentId] || '')
            let needsFetch = forceAssignmentsRefresh || !hasSyncToken || lastSyncedUpdatedAt !== latestUpdatedAt
            if (needsFetch) {
                assignmentsToFetch.push(assignment)
            }
        })

        let totalAssignmentsCount = assignments.length
        let cachedAssignmentsCount = Math.max(0, totalAssignmentsCount - assignmentsToFetch.length)
        setCanvasFetchProgress(
            totalAssignmentsCount,
            cachedAssignmentsCount,
            0,
            `Ready: ${cachedAssignmentsCount}/${totalAssignmentsCount} cached, ${assignmentsToFetch.length} to fetch`
        )

        let submissionsByAssignment = { ...cachedSubmissionsByAssignment }
        let submissionSyncMap = { ...cachedSubmissionSyncMap }
        let unmatchedCount = 0
        let baseUrl = String(mapperState.canvasBaseUrl || '')

        if (assignmentsToFetch.length > 0) {
            baseUrl = await ensureCanvasBaseUrl(false)
            setCanvasFetchStatus(`Fetching student roster for ${assignmentsToFetch.length} updated assignment(s)...`)
            setCanvasFetchProgress(
                totalAssignmentsCount,
                cachedAssignmentsCount,
                0,
                `Preparing roster for ${assignmentsToFetch.length} updated assignment(s)`
            )
            let students = await fetchCanvasStudentsForCourse(selectedCourseId, baseUrl)
            let workerCount = Math.max(1, Math.min(canvasSubmissionsFetchConcurrency, assignmentsToFetch.length))
            let nextFetchIndex = 0
            let startedFetches = 0
            let completedFetches = 0
            let activeFetches = 0
            let fetchError = null

            function updateParallelFetchProgress(activeAssignmentName = '') {
                let fetchedOverall = cachedAssignmentsCount + completedFetches
                let remaining = Math.max(0, totalAssignmentsCount - fetchedOverall - activeFetches)
                let label = `${fetchedOverall}/${totalAssignmentsCount} fetched, ${activeFetches} in progress, ${remaining} remaining`
                if (activeFetches > 0 && activeAssignmentName) {
                    label = `Fetching ${Math.min(totalAssignmentsCount, fetchedOverall + 1)}/${totalAssignmentsCount}: ${activeAssignmentName}`
                }
                setCanvasFetchProgress(totalAssignmentsCount, fetchedOverall, activeFetches, label)
            }

            async function fetchAssignmentWorker() {
                while (nextFetchIndex < assignmentsToFetch.length) {
                    if (fetchError) {
                        return
                    }

                    let queueIndex = nextFetchIndex
                    nextFetchIndex += 1

                    let assignment = assignmentsToFetch[queueIndex]
                    let assignmentId = String(assignment && assignment.id ? assignment.id : '')
                    if (!assignmentId) {
                        continue
                    }

                    startedFetches += 1
                    activeFetches += 1
                    let startedOverall = cachedAssignmentsCount + startedFetches
                    setCanvasFetchStatus(`Fetching ${startedOverall}/${totalAssignmentsCount}: ${assignment.name}`)
                    updateParallelFetchProgress(assignment.name)

                    try {
                        let result = await fetchCanvasSubmissionsForAssignment(selectedCourseId, assignment, students, baseUrl, {
                            showStatus: false
                        })
                        submissionsByAssignment[assignmentId] = result.submissions
                        submissionSyncMap[assignmentId] = String(assignment && assignment.updated_at ? assignment.updated_at : '')
                        unmatchedCount += result.unmatchedCount
                    } catch (e) {
                        fetchError = e
                        throw e
                    } finally {
                        activeFetches = Math.max(0, activeFetches - 1)
                        completedFetches += 1
                        updateParallelFetchProgress()
                    }
                }
            }

            await Promise.all(Array.from({ length: workerCount }, () => fetchAssignmentWorker()))
            if (fetchError) {
                throw fetchError
            }
        } else {
            setCanvasFetchStatus(`No assignment updates detected; using cached submissions for ${assignments.length} assignment(s).`)
            setCanvasFetchProgress(
                totalAssignmentsCount,
                totalAssignmentsCount,
                0,
                `No assignment updates detected; using cached submissions for ${totalAssignmentsCount} assignment(s).`
            )
        }

        assignments.forEach((assignment) => {
            let assignmentId = String(assignment && assignment.id ? assignment.id : '')
            if (!assignmentId) {
                return
            }
            if (!Object.prototype.hasOwnProperty.call(submissionSyncMap, assignmentId)) {
                submissionSyncMap[assignmentId] = String(assignment && assignment.updated_at ? assignment.updated_at : '')
            }
        })

        await persistCanvasCourseCaches(selectedCourseId, assignments, submissionsByAssignment, submissionSyncMap, baseUrl)
        await loadMapperStateFromStorage()
        renderCanvasAssignmentSummary()

        if (unmatchedCount > 0) {
            console.log(`Ignored ${unmatchedCount} Canvas submissions that did not map to fetched course students.`)
        }
        let fetchedAssignmentsCount = assignmentsToFetch.length
        let reusedAssignmentsCount = Math.max(0, assignments.length - fetchedAssignmentsCount)
        let doneMessage = `Fetched ${assignments.length} assignment(s) for selected course.`
        if (fetchedAssignmentsCount === 0) {
            doneMessage = `No assignment updates detected. Reused cached submissions for ${reusedAssignmentsCount} assignment(s).`
        } else if (reusedAssignmentsCount > 0) {
            doneMessage = `Fetched ${fetchedAssignmentsCount} updated assignment(s); reused cached submissions for ${reusedAssignmentsCount}.`
        }
        if (canvasCacheTrimmedForQuota) {
            doneMessage += ' Cache trimmed to current course due to storage limits.'
        }
        setCanvasFetchProgress(
            totalAssignmentsCount,
            totalAssignmentsCount,
            0,
            doneMessage
        )
        if (manageLoading) {
            endCanvasFetch(doneMessage, false, 'fetch')
        } else {
            setCanvasFetchStatus(doneMessage)
        }

        return {
            assignmentsCount: assignments.length,
            unmatchedCount: unmatchedCount,
            fetchedAssignmentsCount: fetchedAssignmentsCount,
            reusedAssignmentsCount: reusedAssignmentsCount
        }
    } catch (e) {
        renderCanvasAssignmentSummary()
        if (isAbortError(e)) {
            if (manageLoading) {
                endCanvasFetch('Canvas fetch stopped by user.', false, 'fetch')
            } else {
                setCanvasFetchStatus('Canvas fetch stopped by user.')
            }
            return null
        }
        if (manageLoading) {
            endCanvasFetch(`Canvas fetch failed: ${e.message}`, true, 'fetch')
        } else {
            setCanvasFetchStatus(`Canvas fetch failed: ${e.message}`, true)
        }
        return null
    }
}

async function clearMapperDataForCourseChange(selectedCourseId) {
    let safeCourseId = String(selectedCourseId || '')

    setActiveCourseDataFromCache(safeCourseId)
    mapperState.mappings = []

    let firstSubmissions = getFirstSubmissionsForAssignments(mapperState.assignments, mapperState.submissionsByAssignment)
    suppressNextMappingsRefresh = true
    await chrome.storage.local.set({
        canvasCourseId: safeCourseId,
        assignments: mapperState.assignments,
        submissionsByAssignment: mapperState.submissionsByAssignment,
        submissions: firstSubmissions,
        [mapperStorageKey]: []
    })

    $('#bsd-map-cards').html('')
    mappingCardCounter = 0
    mappingRowCounter = 0

    renderCanvasAssignmentSummary()
    updateMapperReadyUi()
}

async function onCanvasCourseSelectionChanged(forceAssignmentsRefresh = false) {
    if (canvasFetchInFlight) {
        return
    }

    let previousCourseId = String(mapperState.selectedCanvasCourseId || '')
    let selectedCourseId = String($('#bsd-canvas-course-select').val() || '')
    let courseChanged = previousCourseId !== selectedCourseId

    if (courseChanged) {
        await clearMapperDataForCourseChange(selectedCourseId)
        setMapperStatus('Canvas course changed. Existing auto-matches cleared.')
    } else {
        mapperState.selectedCanvasCourseId = selectedCourseId
        await chrome.storage.local.set({ canvasCourseId: selectedCourseId })
    }
    await persistCanvasCourseMatchForCurrentSynergyCourse(
        selectedCourseId,
        getCanvasCourseNameForId(selectedCourseId)
    )

    await loadCanvasAssignmentsForSelectedCourse({
        courseId: selectedCourseId,
        manageLoading: true,
        forceRefresh: forceAssignmentsRefresh
    })
}

function normalizeHeaderText(text) {
    if (!text) {
        return ''
    }
    return String(text)
        .replace(/\s+/g, ' ')
        .replace(/[|]+/g, ' ')
        .trim()
}

function stripHtmlToText(text) {
    if (!text) {
        return ''
    }

    let raw = String(text)
    if (!/[<&]/.test(raw)) {
        return normalizeHeaderText(raw)
    }

    let temp = document.createElement('div')
    temp.innerHTML = raw
    return normalizeHeaderText(temp.textContent || temp.innerText || '')
}

function truncateText(text, maxLength = 96) {
    let clean = normalizeHeaderText(text)
    if (!clean) {
        return ''
    }
    if (clean.length <= maxLength) {
        return clean
    }
    return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
}

function getRubricDisplayParts(rubric) {
    let code = normalizeHeaderText(rubric && rubric.alt_code ? rubric.alt_code : '')
    let detail = stripHtmlToText(rubric && rubric.alt_text ? rubric.alt_text : '')
    return { code, detail }
}

function getRubricMatchText(rubric) {
    let parts = getRubricDisplayParts(rubric)
    return normalizeHeaderText(`${parts.code} ${parts.detail}`.trim())
}

function getRubricOptionLabel(rubric) {
    let parts = getRubricDisplayParts(rubric)
    let detail = truncateText(parts.detail, 48)

    if (parts.code && detail) {
        return `${parts.code} - ${detail}`
    }
    if (parts.code) {
        return parts.code
    }
    if (detail) {
        return detail
    }
    return `Rubric ${String(rubric && rubric.id ? rubric.id : '').trim() || '?'}`
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

function assignmentSimilarityScore(targetText, candidateText) {
    let target = normalizeForMatch(targetText)
    let candidate = normalizeForMatch(candidateText)
    if (!target || !candidate) {
        return 0
    }
    if (target === candidate) {
        return 1
    }

    let targetTokenCount = target.split(' ').filter(Boolean).length
    let candidateTokenCount = candidate.split(' ').filter(Boolean).length
    let canContainPriority = target.length >= 6 && targetTokenCount >= 2 && candidateTokenCount >= targetTokenCount

    // If the Synergy title appears inside the Canvas title, prioritize this over nearby fuzzy matches.
    if (canContainPriority && candidate.includes(target)) {
        let coverage = Math.min(1, target.length / Math.max(candidate.length, 1))
        return Math.min(0.995, 0.95 + (0.04 * coverage))
    }

    if (target.includes(candidate) && candidate.length >= 6 && candidateTokenCount >= 2) {
        let coverage = Math.min(1, candidate.length / Math.max(target.length, 1))
        return Math.min(0.9, 0.82 + (0.08 * coverage))
    }

    return similarityScore(target, candidate)
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

function findBestMatch(targetText, candidates, getText, threshold = 0.5, scoreFn = similarityScore) {
    let best = null
    let bestScore = -1
    candidates.forEach((candidate) => {
        let candidateText = getText(candidate)
        let score = scoreFn(targetText, candidateText)
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

function findBestAltMatch(targetAlt, rubrics, threshold = altMatchThreshold) {
    let best = null
    let bestScore = -1
    rubrics.forEach((rubric) => {
        let rubricText = getRubricMatchText(rubric)
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

function getVisibleSynergyColumns() {
    return Array.isArray(mapperState.columns) ? mapperState.columns : []
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

function getAssignmentById(assignments, assignId) {
    if (!assignments || assignments.length === 0) {
        return null
    }
    let match = null
    assignments.forEach((assignment) => {
        if (String(assignment.id) === String(assignId)) {
            match = assignment
        }
    })
    return match
}

function getRubrics(assignment) {
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

function getAssignmentUpdatedText(assignment) {
    if (!assignment) {
        return '-'
    }
    let assignmentId = String(assignment.id || '')
    let submissions = assignmentId ? mapperState.submissionsByAssignment[assignmentId] : []
    let mostRecentPostedAt = getMostRecentPostedAtFromSubmissions(submissions)
    let value = mostRecentPostedAt || assignment.updated_at || assignment.due_at || assignment.created_at
    return formatCanvasDateTime(value)
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

function hasFetchedSubmissionsReady() {
    return getFetchedAssignmentsForMapper().length > 0
}

function hasPasteReadyMappings() {
    let ready = false
    $('#bsd-map-cards .bsd-map-row').each((_, rowEl) => {
        if (isRowMappingComplete($(rowEl))) {
            ready = true
            return false
        }
    })
    return ready
}

function hasSelectedCanvasCourse() {
    let selectedCourseId = String($('#bsd-canvas-course-select').val() || mapperState.selectedCanvasCourseId || '').trim()
    if (!selectedCourseId) {
        return false
    }

    if (Array.isArray(mapperState.canvasCourses) && mapperState.canvasCourses.some((course) => String(course.id) === selectedCourseId)) {
        return true
    }

    let selectEl = document.getElementById('bsd-canvas-course-select')
    if (!selectEl || !selectEl.options) {
        return false
    }
    return Array.from(selectEl.options).some((option) => String(option.value) === selectedCourseId)
}

function updateCourseStepUi() {
    let hasCourse = hasSelectedCanvasCourse()
    let hasFetched = hasCourse && hasFetchedSubmissionsReady()
    let hasPasteReady = hasFetched && hasPasteReadyMappings()
    let root = $('#bsd-sidepanel')

    root.toggleClass('bsd-course-unselected', !hasCourse)
    root.toggleClass('bsd-course-selected', hasCourse)
    root.toggleClass('bsd-step-1-active', !hasCourse)
    root.toggleClass('bsd-step-2-active', hasCourse && !hasFetched)
    root.toggleClass('bsd-step-3-active', hasFetched && !hasPasteReady)
    root.toggleClass('bsd-step-4-active', hasPasteReady)
}

function updateMapperReadyUi() {
    let ready = hasSelectedCanvasCourse() && hasFetchedSubmissionsReady()
    $('.bsd-panel-settings').toggleClass('bsd-no-submissions', !ready)
    $('.bsd-add-assignment-row').toggleClass('bsd-no-submissions', !ready)
    $('.bsd-sort-controls').toggleClass('bsd-no-submissions', !ready)
    $('.bsd-controls').toggleClass('bsd-no-submissions', !ready)
    $('#bsd-map-cards').toggleClass('bsd-no-submissions', !ready)
    updateCourseStepUi()
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

    let rubricOptions = getRubrics(assignment)
        .map((rubric) => ({
            rubric,
            optionLabel: getRubricOptionLabel(rubric),
            optionTitle: getRubricMatchText(rubric)
        }))
        .sort((left, right) => {
            let labelCompare = left.optionLabel.localeCompare(right.optionLabel, undefined, { sensitivity: 'base', numeric: true })
            if (labelCompare !== 0) {
                return labelCompare
            }
            return String(left.rubric.id || '').localeCompare(String(right.rubric.id || ''), undefined, { numeric: true })
        })

    rubricOptions.forEach(({ rubric, optionLabel, optionTitle }) => {
        let option = $('<option></option>')
            .attr('value', String(rubric.id))
            .attr('title', optionTitle)
            .text(optionLabel)
        if (String(selectedRubricId) === String(rubric.id)) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })
}

function updateCanvasUpdatedCell(card, assignmentId) {
    let assignment = getAssignmentById(mapperState.assignments, assignmentId)
    card.find('.bsd-canvas-updated').text(getAssignmentUpdatedText(assignment))
}

function getMapperCards() {
    return $('#bsd-map-cards .bsd-map-card')
}

function getCardLastUpdatedTimestamp(card) {
    let assignmentId = getCardCanvasAssignment(card)
    if (!assignmentId) {
        return -1
    }
    let assignment = getAssignmentById(mapperState.assignments, assignmentId)
    if (!assignment) {
        return -1
    }
    let assignmentIdKey = String(assignment.id || '')
    let submissions = assignmentIdKey ? mapperState.submissionsByAssignment[assignmentIdKey] : []
    let mostRecentPostedAt = getMostRecentPostedAtFromSubmissions(submissions)
    let value = mostRecentPostedAt || assignment.updated_at || assignment.due_at || assignment.created_at
    if (!value) {
        return -1
    }
    let parsed = Date.parse(String(value))
    return Number.isNaN(parsed) ? -1 : parsed
}

function compareTextAsc(left, right) {
    return String(left || '').localeCompare(String(right || ''), undefined, {
        numeric: true,
        sensitivity: 'base'
    })
}

function getCardSortStableId(card) {
    return Number(card.attr('data-card-id') || 0)
}

function getCardCanvasAssignmentName(card) {
    let assignmentId = getCardCanvasAssignment(card)
    if (assignmentId) {
        let assignment = getAssignmentById(mapperState.assignments, assignmentId)
        if (assignment && assignment.name) {
            return normalizeHeaderText(assignment.name)
        }
    }

    let selectedLabel = normalizeHeaderText(card.find('.bsd-card-canvas-assign-select option:selected').text())
    if (selectedLabel.toLowerCase() === 'choose canvas assignment') {
        return ''
    }
    return selectedLabel
}

function getCardSynergyAssignmentName(card) {
    return normalizeHeaderText(getCardSynergyAssignment(card))
}

function getSynergyAssignmentOrderMap() {
    let grouped = getSynergyColumnsByAssignment()
    let columns = getVisibleSynergyColumns()
    let order = {}
    columns.forEach((column, idx) => {
        let raw = normalizeHeaderText(column && column.assignment_label ? column.assignment_label : '')
        if (!raw) {
            return
        }
        let resolved = resolveSynergyAssignmentName(raw, grouped) || raw
        if (!Object.prototype.hasOwnProperty.call(order, resolved)) {
            order[resolved] = idx
        }
    })
    return order
}

function getSynergyAssignmentOrderIndex(assignmentName, orderMap) {
    let key = String(assignmentName || '')
    if (!key || !orderMap || !Object.prototype.hasOwnProperty.call(orderMap, key)) {
        return Number.MAX_SAFE_INTEGER
    }
    return Number(orderMap[key])
}

function compareMapperCardsByMethod(aCard, bCard, sortMethod, synergyOrderMap = null) {
    let method = normalizeMapperSortMethod(sortMethod, defaultMapperSortMethod)

    if (method === 'canvas_name_asc') {
        let canvasCompare = compareTextAsc(getCardCanvasAssignmentName(aCard), getCardCanvasAssignmentName(bCard))
        if (canvasCompare !== 0) {
            return canvasCompare
        }
    } else if (method === 'synergy_name_asc') {
        let synergyCompare = compareTextAsc(getCardSynergyAssignmentName(aCard), getCardSynergyAssignmentName(bCard))
        if (synergyCompare !== 0) {
            return synergyCompare
        }
    } else if (method === 'synergy_order_ltr') {
        let aOrder = getSynergyAssignmentOrderIndex(getCardSynergyAssignment(aCard), synergyOrderMap)
        let bOrder = getSynergyAssignmentOrderIndex(getCardSynergyAssignment(bCard), synergyOrderMap)
        if (aOrder !== bOrder) {
            return aOrder - bOrder
        }
    } else {
        let aTime = getCardLastUpdatedTimestamp(aCard)
        let bTime = getCardLastUpdatedTimestamp(bCard)
        if (aTime !== bTime) {
            return bTime - aTime
        }
    }

    let synergyLabelCompare = compareTextAsc(getCardSynergyAssignmentName(aCard), getCardSynergyAssignmentName(bCard))
    if (synergyLabelCompare !== 0) {
        return synergyLabelCompare
    }

    let canvasLabelCompare = compareTextAsc(getCardCanvasAssignmentName(aCard), getCardCanvasAssignmentName(bCard))
    if (canvasLabelCompare !== 0) {
        return canvasLabelCompare
    }

    return getCardSortStableId(aCard) - getCardSortStableId(bCard)
}

function sortMapperCards(sortMethod = mapperState.sortMethod, showStatus = false) {
    let resolvedSortMethod = normalizeMapperSortMethod(sortMethod, mapperState.sortMethod)
    mapperState.sortMethod = resolvedSortMethod
    updateSortControlsFromState()

    let container = $('#bsd-map-cards')
    let cards = container.children('.bsd-map-card').get()
    if (cards.length <= 1) {
        if (showStatus) {
            let noun = cards.length === 1 ? 'tile' : 'tiles'
            setMapperStatus(`Sorted ${cards.length} ${noun} by ${getMapperSortMethodLabel(resolvedSortMethod)}.`)
        }
        return
    }

    let synergyOrderMap = resolvedSortMethod === 'synergy_order_ltr' ? getSynergyAssignmentOrderMap() : null
    cards.sort((a, b) => compareMapperCardsByMethod($(a), $(b), resolvedSortMethod, synergyOrderMap))

    cards.forEach((cardEl) => {
        container.append(cardEl)
    })

    if (showStatus) {
        setMapperStatus(`Sorted ${cards.length} tiles by ${getMapperSortMethodLabel(resolvedSortMethod)}.`)
    }
}

function sortMapperCardsByMostRecentUpdate() {
    sortMapperCards('canvas_recent_desc', false)
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
        assignmentMatchThreshold,
        assignmentSimilarityScore
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
    updateCardPasteStates(card)

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

function autoMatchAllMappings(force = false, showStatus = true, shouldPersist = true) {
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
    sortMapperCards(mapperState.sortMethod)

    if (shouldPersist) {
        persistMappingsFromUi()
    }
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
            <div class="bsd-row-field bsd-row-field-synergy">
                <span class="bsd-inline-label">Synergy:</span>
                <select class="bsd-syn-alt-select"></select>
            </div>
            <div class="bsd-row-field bsd-row-field-canvas">
                <span class="bsd-inline-label">Canvas:</span>
                <select class="bsd-canvas-alt-select"></select>
            </div>
            <div class="bsd-row-buttons">
                <button class="bsd-row-paste" type="button">Paste</button>
                <button class="bsd-row-remove bsd-x-remove" type="button" title="Remove ALT">x</button>
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
        clearInlineMappingErrors(card)
        autoMatchCanvasAltForRow(row, false)
        updateCardPasteStates(card)
        persistMappingsFromUi()
    })

    canvasAltSelect.on('change', () => {
        clearInlineMappingErrors(card)
        updateCardPasteStates(card)
        persistMappingsFromUi()
    })

    row.find('.bsd-row-remove').on('click', () => {
        clearInlineMappingErrors(card)
        row.remove()
        if (getRowsForCard(card).length === 0) {
            createMapperCardRow(card, getSuggestedRowSeedForCard(card))
        }
        updateCardPasteStates(card)
        persistMappingsFromUi()
    })

    row.find('.bsd-row-paste').on('click', async () => {
        await pasteSingleRow(row)
    })

    card.find('.bsd-card-rows').append(row)
    autoMatchCanvasAltForRow(row, false)
    updateCardPasteStates(card)
}

function createMapperCard(cardData = {}) {
    mappingCardCounter += 1
    let normalized = normalizeCardSeedData(cardData)

    let card = $(`
        <div class="bsd-map-card" data-card-id="${mappingCardCounter}">
            <div class="bsd-card-head">
                <div class="bsd-card-title">
                    <span class="bsd-card-title-prefix">Synergy Assignment:</span>
                    <select class="bsd-card-syn-assign-select"></select>
                </div>
                <div class="bsd-card-actions">
                    <button class="bsd-card-add-alt" type="button">Add ALT</button>
                    <button class="bsd-card-paste" type="button">Paste Assignment</button>
                    <button class="bsd-card-remove bsd-x-remove" type="button" title="Remove assignment">x</button>
                </div>
            </div>
            <div class="bsd-card-meta-row">
                <div class="bsd-meta-field bsd-canvas-assign-field">
                    <span class="bsd-inline-label">Canvas Assignment:</span>
                    <select class="bsd-card-canvas-assign-select"></select>
                </div>
                <div class="bsd-meta-field bsd-updated-field">
                    <span class="bsd-inline-label">last updated:</span>
                    <div class="bsd-canvas-updated">-</div>
                </div>
            </div>
            <div class="bsd-standards-wrap">
                <div class="bsd-standards-title">Standards</div>
                <div class="bsd-card-rows"></div>
            </div>
        </div>
    `)

    $('#bsd-map-cards').append(card)

    let synAssignSelect = card.find('.bsd-card-syn-assign-select')
    let canvasAssignSelect = card.find('.bsd-card-canvas-assign-select')

    buildSynergyAssignmentOptions(synAssignSelect, normalized.synergy_assignment)
    buildCanvasAssignmentOptions(canvasAssignSelect, normalized.assignment_id)
    updateCanvasUpdatedCell(card, canvasAssignSelect.val())

    synAssignSelect.on('change', () => {
        clearInlineMappingErrors(card)
        refreshCardRowSynergyAltOptions(card)
        autoMatchCanvasAssignmentForCard(card, false)
        updateCanvasUpdatedCell(card, getCardCanvasAssignment(card))
        refreshCardRowCanvasAltOptions(card)
        getRowsForCard(card).each((_, rowEl) => {
            autoMatchCanvasAltForRow($(rowEl), false)
        })
        updateCardPasteStates(card)
        persistMappingsFromUi()
    })

    canvasAssignSelect.on('change', async () => {
        clearInlineMappingErrors(card)
        let assignmentLabel = getSelectedCanvasAssignmentLabel(canvasAssignSelect)
        if (assignmentLabel) {
            let copied = await copyTextToClipboard(assignmentLabel)
            if (copied) {
                showClipboardCopyTooltip(canvasAssignSelect, 'Copied assignment title')
            }
            if (!copied && !clipboardCopyWarningShown) {
                setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
                clipboardCopyWarningShown = true
            }
        }
        updateCanvasUpdatedCell(card, canvasAssignSelect.val())
        refreshCardRowCanvasAltOptions(card)
        getRowsForCard(card).each((_, rowEl) => {
            autoMatchCanvasAltForRow($(rowEl), false)
        })
        updateCardPasteStates(card)
        persistMappingsFromUi()
    })

    card.find('.bsd-card-add-alt').on('click', () => {
        clearInlineMappingErrors(card)
        createMapperCardRow(card, getSuggestedRowSeedForCard(card))
        updateCardPasteStates(card)
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

        for (let i = 0; i < rows.length; i++) {
            await pasteSingleRow($(rows[i]))
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
    updateCardPasteStates(card)
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
    suppressNextMappingsRefresh = true
    chrome.storage.local.set({ [mapperStorageKey]: mappings })
}

function clearMapperMappings(showStatus = true) {
    $('#bsd-map-cards').html('')
    mapperState.mappings = []
    suppressNextMappingsRefresh = true
    chrome.storage.local.set({ [mapperStorageKey]: [] })
    if (showStatus) {
        setMapperStatus('Mappings cleared. Click Add Assignment or Auto-Match.')
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

function clearInlineMappingErrors(card) {
    if (!card || card.length === 0) {
        return
    }
    card.find('.bsd-inline-error').remove()
    card.find('.bsd-input-error').removeClass('bsd-input-error')
}

function showInlineMappingError(inputEl, text) {
    let input = $(inputEl)
    if (input.length === 0) {
        return
    }

    input.addClass('bsd-input-error')
    let container = input.closest('.bsd-row-field, .bsd-meta-field')
    if (container.length === 0) {
        input.after(`<div class="bsd-inline-error">${text}</div>`)
        return
    }

    container.find('.bsd-inline-error').remove()
    container.append(`<div class="bsd-inline-error">${text}</div>`)
}

function isRowMappingComplete(row) {
    let mapping = getMappingFromRow(row)
    return Boolean(mapping.col_index && mapping.assignment_id && mapping.rubric_id)
}

function isRowTargetUnmatched(row) {
    let mapping = getMappingFromRow(row)
    return Boolean(mapping.col_index && mapping.assignment_id && !mapping.rubric_id)
}

function updateRowMatchHighlight(row) {
    row.toggleClass('bsd-row-unmatched-target', isRowTargetUnmatched(row))
}

function updateCardMatchHighlight(card) {
    let hasUnmatchedTargets = false
    getRowsForCard(card).each((_, rowEl) => {
        if (isRowTargetUnmatched($(rowEl))) {
            hasUnmatchedTargets = true
            return false
        }
    })
    card.toggleClass('bsd-card-unmatched-target', hasUnmatchedTargets)
}

function getCardMappingState(card) {
    let hasCardAssignment = Boolean(getCardCanvasAssignment(card))
    let hasAnyRowSelections = false
    let rows = getRowsForCard(card)
    let complete = hasCardAssignment && rows.length > 0

    rows.each((_, rowEl) => {
        let row = $(rowEl)
        let mapping = getMappingFromRow(row)
        if (mapping.col_index || mapping.rubric_id) {
            hasAnyRowSelections = true
        }
        if (!isRowMappingComplete(row)) {
            complete = false
        }
    })

    let hasAnyMappedInput = hasCardAssignment || hasAnyRowSelections
    return {
        complete: complete,
        incomplete: hasAnyMappedInput && !complete
    }
}

function updateRowPasteButtonState(row) {
    let complete = isRowMappingComplete(row)
    row.find('.bsd-row-paste').prop('disabled', !complete)
}

function updateCardPasteButtonState(card) {
    let complete = Boolean(getCardCanvasAssignment(card))
    if (complete) {
        getRowsForCard(card).each((_, rowEl) => {
            if (!isRowMappingComplete($(rowEl))) {
                complete = false
                return false
            }
        })
    }
    card.find('.bsd-card-paste').prop('disabled', !complete)
}

function updateCardPasteStates(card) {
    if (!card || card.length === 0) {
        return
    }
    getRowsForCard(card).each((_, rowEl) => {
        let row = $(rowEl)
        updateRowPasteButtonState(row)
        updateRowMatchHighlight(row)
    })
    updateCardPasteButtonState(card)
    updateCardMatchHighlight(card)
    let mappingState = getCardMappingState(card)
    card.toggleClass('bsd-card-ready', mappingState.complete)
    card.toggleClass('bsd-card-incomplete', mappingState.incomplete)
    updateCourseStepUi()
}

async function pasteSingleRow(row) {
    let status = row.find('.bsd-row-status')
    let mapping = getMappingFromRow(row)
    let card = getCardFromRow(row)

    if (!mapping.col_index || !mapping.assignment_id || !mapping.rubric_id) {
        clearInlineMappingErrors(card)
        let missingInput = null
        if (!mapping.assignment_id) {
            missingInput = card.find('.bsd-card-canvas-assign-select')
        } else if (!mapping.col_index) {
            missingInput = row.find('.bsd-syn-alt-select')
        } else if (!mapping.rubric_id) {
            missingInput = row.find('.bsd-canvas-alt-select')
        }
        showInlineMappingError(missingInput, 'Error: Mapping is incomplete.')
        status.text('')
        updateCardPasteStates(card)
        return
    }

    try {
        clearInlineMappingErrors(card)
        let tab = await resolveSynergyTab()
        if (!tab) {
            throw new Error('Open a Synergy gradebook tab before pasting.')
        }
        mapperState.activeTabId = tab.id
        mapperState.activeTabUrl = tab.url || ''

        status.css('color', '#b4f7fe').text('Pasting...')
        let result = await requestSynergyPaste(tab.id, mapping)
        let statusText = `Done: ${result.pushed}/${result.matched} pushed`
        let skippedTarget = Number(result && result.skipped_target ? result.skipped_target : 0)
        if (skippedTarget > 0) {
            statusText += `, ${skippedTarget} skipped in section`
        }
        status.css('color', '#b4f7fe').text(statusText)
    } catch (e) {
        status.css('color', '#f9b1b1').text(`Error: ${e.message}`)
    }
}

async function pasteAllMappings() {
    let rows = $('#bsd-map-cards .bsd-map-row')
    if (rows.length === 0) {
        setMapperStatus('No mapping rows to paste.', true)
        return
    }

    let tab = await resolveSynergyTab()
    if (!tab) {
        setMapperStatus('Open a Synergy gradebook tab before pasting.', true)
        return
    }
    mapperState.activeTabId = tab.id
    mapperState.activeTabUrl = tab.url || ''

    setMapperStatus(`Pasting ${rows.length} mapping row(s)...`)
    for (let i = 0; i < rows.length; i++) {
        await pasteSingleRow($(rows[i]))
    }
    setMapperStatus(`Paste run complete for ${rows.length} mapping row(s).`)
}

function renderMappingsFromState() {
    $('#bsd-map-cards').html('')
    mappingCardCounter = 0
    mappingRowCounter = 0

    let seeds = buildCardSeedsFromMappings(mapperState.mappings)
    if (seeds.length === 0) {
        addMapperCard({})
    } else {
        seeds.forEach((seed) => addMapperCard(seed))
    }
    sortMapperCards(mapperState.sortMethod)
}

async function refreshMapperPanel(showStatus = true) {
    if (refreshInFlight) {
        return false
    }
    refreshInFlight = true

    try {
        let tab = await resolveSynergyTab()
        if (!tab) {
            setMapperStatus('Activate a Synergy gradebook tab to use the mapper.', true)
            $('#bsd-map-cards').html('')
            await loadMapperStateFromStorage()
            updateMapperSettingsUiFromState()
            updateSortControlsFromState()
            return false
        }

        mapperState.activeTabId = tab.id
        mapperState.activeTabUrl = tab.url || ''

        await loadMapperStateFromStorage()
        updateMapperSettingsUiFromState()
        updateSortControlsFromState()

        let context = await requestSynergyMapperContext(tab.id)
        mapperState.columns = Array.isArray(context.columns) ? context.columns : []
        mapperState.synergyStudentIds = Array.isArray(context.studentIds)
            ? context.studentIds.map((id) => normalizeSynergyId(id)).filter(Boolean)
            : []
        updateSynergyCourseContextFromResponse(context)
        mapperState.viewMode = context.viewMode || 'view_by_assignment'

        renderMappingsFromState()
        autoMatchAllMappings(false, false, false)

        if (showStatus) {
            let fetchedCount = getFetchedAssignmentsForMapper().length
            if (fetchedCount === 0) {
                setMapperStatus('No fetched Canvas assignments found. Load Canvas courses, select a course, then click "Fetch Canvas Scores".', true)
            } else if (mapperState.columns.length === 0) {
                setMapperStatus('Synergy columns not detected yet. Refresh gradebook and click Refresh Data.', true)
            } else {
                setMapperStatus(`Loaded ${fetchedCount} fetched Canvas assignment(s) and ${mapperState.columns.length} Synergy column(s).`)
            }
        }
        return true
    } catch (e) {
        setMapperStatus(`Mapper refresh failed: ${e.message}`, true)
        return false
    } finally {
        refreshInFlight = false
    }
}

function didSynergyCourseContextChange(previousKey, previousDisplay) {
    let prevKey = String(previousKey || '')
    let nextKey = String(mapperState.synergyCourseKey || '')
    if (prevKey || nextKey) {
        return prevKey !== nextKey
    }

    let prevDisplay = normalizeSynergyCourseDisplay(previousDisplay || '')
    let nextDisplay = normalizeSynergyCourseDisplay(mapperState.synergyCourseDisplay || '')
    return prevDisplay !== nextDisplay
}

async function runRefreshWorkflow() {
    if (canvasFetchInFlight) {
        setMapperStatus('Canvas fetch is in progress. Stop fetch before running Refresh.', true)
        return
    }

    let previousSynergyCourseKey = String(mapperState.synergyCourseKey || '')
    let previousSynergyCourseDisplay = String(mapperState.synergyCourseDisplay || '')

    setMapperStatus('Refreshing Synergy context...')
    let refreshed = await refreshMapperPanel(false)
    if (!refreshed) {
        return
    }

    if (didSynergyCourseContextChange(previousSynergyCourseKey, previousSynergyCourseDisplay)) {
        await loadCanvasCourses(false, { resetSelectedCourse: true })
    }

    let assignmentNames = Object.keys(getSynergyColumnsByAssignment())
    if (assignmentNames.length === 0) {
        setMapperStatus('Synergy columns not detected yet. Refresh gradebook and click Refresh again.', true)
        return
    }

    clearMapperMappings(false)
    autoMatchAllMappings(true, true, true)
}

function setInstructionHoverStep(stepNumber = 0) {
    let root = $('#bsd-sidepanel')
    root.removeClass('bsd-hover-step-1 bsd-hover-step-2 bsd-hover-step-3 bsd-hover-step-4')
    if (stepNumber >= 1 && stepNumber <= 4) {
        root.addClass(`bsd-hover-step-${stepNumber}`)
    }
}

function wireInstructionHoverUi() {
    ;[1, 2, 3, 4].forEach((step) => {
        let selector = `#bsd-step-title-${step}`
        $(selector).on('mouseenter', () => setInstructionHoverStep(step))
        $(selector).on('mouseleave', () => setInstructionHoverStep(0))
    })
}

function wireUiEvents() {
    $('#bsd-load-canvas-courses').on('click', async () => {
        await loadCanvasCourses(true)
    })

    $('#bsd-canvas-include-concluded').on('change', async () => {
        mapperState.canvasIncludeConcludedCourses = Boolean($('#bsd-canvas-include-concluded').prop('checked'))
        setCanvasCourseStatus('Course scope changed. Click "Load Courses" to refresh list.')
    })

    $('#bsd-canvas-course-filter').on('input', () => {
        mapperState.canvasCourseFilter = String($('#bsd-canvas-course-filter').val() || '')
        renderCanvasCourseOptions()
    })

    $('#bsd-canvas-course-select').on('change', async () => {
        await onCanvasCourseSelectionChanged(false)
    })

    $('#bsd-fetch-course-assignments').on('click', async () => {
        suppressLocalRefreshEvents = true
        try {
            clearMapperMappings(false)
            let fetchResult = await fetchAllCanvasDataForCourse(mapperState.selectedCanvasCourseId, {
                manageLoading: true,
                forceAssignmentsRefresh: false
            })

            if (!fetchResult) {
                return
            }

            await refreshMapperPanel(false)
            autoMatchAllMappings(true, true, true)
        } finally {
            suppressLocalRefreshEvents = false
        }
    })

    $('#bsd-stop-canvas-fetch').on('click', () => {
        stopCanvasFetch()
    })

    $('#bsd-refresh-data').on('click', async () => {
        await runRefreshWorkflow()
    })

    $('#bsd-sort-method').on('change', () => {
        persistSortMethodFromUi()
    })

    $('#bsd-apply-sort').on('click', () => {
        persistSortMethodFromUi()
        sortMapperCards(mapperState.sortMethod, true)
    })

    $('#bsd-add-mapping').on('click', () => {
        addMapperCard({})
        persistMappingsFromUi()
    })

    $('#bsd-paste-all').on('click', async () => {
        await pasteAllMappings()
    })

    $('#bsd-round-up-from').on('input change', () => {
        queuePersistSettingsFromUi(false)
    })

    $('#bsd-missing-pref').on('change', () => {
        queuePersistSettingsFromUi(true)
    })
}

async function initializeCanvasSourceUi() {
    $('#bsd-canvas-include-concluded').prop('checked', Boolean(mapperState.canvasIncludeConcludedCourses))
    $('#bsd-canvas-course-filter').val(mapperState.canvasCourseFilter || '')
    renderCanvasCourseOptions()
    renderCanvasAssignmentSummary()
    setCanvasCourseStatus('Open an authenticated Canvas tab, then click "Load Courses".')
    setCanvasFetchStatus('')
    clearCanvasFetchProgress()
    updateCanvasActionButtons()
    await loadCanvasCourses(false)
}

function wireBackgroundEvents() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            let mappingChanged = Boolean(changes[mapperStorageKey])
            if (mappingChanged && suppressNextMappingsRefresh) {
                suppressNextMappingsRefresh = false
                return
            }

            let relevant = Boolean(changes.assignments || changes.submissionsByAssignment || mappingChanged)
            if (relevant && suppressLocalRefreshEvents) {
                return
            }
            if (relevant) {
                refreshMapperPanel(false)
            }
            return
        }

        if (areaName === 'sync' && (changes.roundUpFrom || changes.missingPref)) {
            refreshMapperPanel(false)
        }
    })

    chrome.tabs.onActivated.addListener(() => {
        refreshMapperPanel(false)
    })

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!mapperState.activeTabId) {
            return
        }
        if (tabId !== mapperState.activeTabId) {
            return
        }
        if (changeInfo.status === 'complete') {
            refreshMapperPanel(false)
        }
    })
}

$(async () => {
    wireUiEvents()
    wireInstructionHoverUi()
    wireBackgroundEvents()
    await refreshMapperPanel(true)
    await initializeCanvasSourceUi()
})
