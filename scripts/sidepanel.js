const mapperStorageKey = 'synergyColumnMappings'
const mapperMappingsByPairStorageKey = 'synergyColumnMappingsByPair'
const manualAlignmentsByPairStorageKey = 'manualAlignmentsByPair'
const synergyCanvasMatchStorageKey = 'synergyCanvasCourseMatches'
const mapperSortMethodStorageKey = 'mapperSortMethod'
const canvasAssignmentsByCourseStorageKey = 'canvasAssignmentsByCourse'
const submissionsByAssignmentByCourseStorageKey = 'submissionsByAssignmentByCourse'
const canvasSubmissionSyncByCourseStorageKey = 'canvasSubmissionSyncByCourse'
const defaultMapperSortMethod = 'canvas_recent_desc'
const canvasSubmissionsFetchConcurrency = 6
const canvasAssignmentsFetchConcurrency = 4
const canvasCourseRosterMatchConcurrency = 6
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
    copiedCanvasAssignmentId: '',
    assignmentHelperExpanded: false,
    canvasCourseFilter: '',
    canvasIncludeConcludedCourses: false,
    canvasCourses: [],
    canvasAssignmentsByCourse: {},
    submissionsByAssignmentByCourse: {},
    canvasSubmissionSyncByCourse: {},
    canvasStudentsByCourse: {},
    canvasAuthRequired: false,
    viewMode: 'view_by_assignment',
    columns: [],
    assignments: [],
    submissionsByAssignment: {},
    roundUpFrom: 0.5,
    missingPref: 'skip',
    sortMethod: defaultMapperSortMethod,
    mappings: [],
    mappingsByPair: {},
    manualAlignmentsByPair: {}
}

let mappingCardCounter = 0
let mappingRowCounter = 0
let suppressNextMappingsRefresh = false
let suppressLocalRefreshEvents = false
let refreshInFlight = false
let canvasFetchInFlight = false
let refreshActionInFlight = false
let canvasFetchController = null
let settingsPersistTimer = null
let clipboardCopyWarningShown = false
let clipboardCopyTooltipHideTimer = null
let pasteAllToastHideTimer = null
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

function setPasteAllActivity(active, text = 'Pasting...') {
    let activity = $('#bsd-paste-all-activity')
    let activityText = $('#bsd-paste-all-activity-text')
    let button = $('#bsd-paste-all')

    if (activityText.length > 0) {
        activityText.text(String(text || 'Pasting...'))
    }

    if (active) {
        activity.removeClass('bsd-hidden')
        button.prop('disabled', true)
        return
    }

    activity.addClass('bsd-hidden')
    button.prop('disabled', !hasPasteReadyMappings())
}

function setRefreshActivity(active, text = 'Refreshing...') {
    let activity = $('#bsd-refresh-activity')
    let activityText = $('#bsd-refresh-activity-text')

    refreshActionInFlight = Boolean(active)

    if (activityText.length > 0) {
        activityText.text(String(text || 'Refreshing...'))
    }

    if (active) {
        activity.removeClass('bsd-hidden')
        updateCanvasActionButtons()
        updateCopyCanvasAssignmentVisibility()
        return
    }

    activity.addClass('bsd-hidden')
    updateCanvasActionButtons()
    updateCopyCanvasAssignmentVisibility()
}

function showPasteAllToast(text, isError = false, durationMs = 2200) {
    let toast = $('#bsd-paste-all-toast')
    if (toast.length === 0) {
        return
    }

    if (pasteAllToastHideTimer) {
        window.clearTimeout(pasteAllToastHideTimer)
        pasteAllToastHideTimer = null
    }

    toast
        .text(String(text || '').trim())
        .toggleClass('bsd-error', Boolean(isError))
        .addClass('bsd-visible')

    pasteAllToastHideTimer = window.setTimeout(() => {
        toast.removeClass('bsd-visible')
        pasteAllToastHideTimer = null
    }, Math.max(600, Number(durationMs) || 2200))
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

function getSynergyCanvasPairKey(synergyCourseKey, canvasCourseId) {
    let synergyKey = String(synergyCourseKey || '').trim()
    let canvasKey = String(canvasCourseId || '').trim()
    if (!synergyKey || !canvasKey) {
        return ''
    }
    return `${synergyKey}::${canvasKey}`
}

function getActiveSynergyCanvasPairKey() {
    return getSynergyCanvasPairKey(mapperState.synergyCourseKey, mapperState.selectedCanvasCourseId)
}

function normalizeMappingRecord(mapping) {
    let safe = mapping || {}
    return {
        col_index: String(safe.col_index || ''),
        synergy_assignment: cleanSynergyAssignmentLabel(safe.synergy_assignment || ''),
        synergy_alt: String(safe.synergy_alt || ''),
        synergy_header_id: String(safe.synergy_header_id || ''),
        assignment_id: String(safe.assignment_id || ''),
        rubric_id: String(safe.rubric_id || '')
    }
}

function normalizeMappingsArray(mappings) {
    if (!Array.isArray(mappings)) {
        return []
    }
    return mappings.map((mapping) => normalizeMappingRecord(mapping))
}

function getStoredMappingsForPairKey(pairKey) {
    let key = String(pairKey || '')
    if (!key) {
        return []
    }
    let byPair = ensurePlainObject(mapperState.mappingsByPair)
    let stored = byPair[key]
    return normalizeMappingsArray(stored)
}

function setStoredMappingsForPairKey(pairKey, mappings) {
    let key = String(pairKey || '')
    if (!key) {
        return
    }
    let byPair = ensurePlainObject(mapperState.mappingsByPair)
    byPair[key] = normalizeMappingsArray(mappings)
    mapperState.mappingsByPair = byPair
}

function getManualSynergyAssignmentKey(synergyAssignment) {
    let normalized = normalizeForMatch(synergyAssignment)
    return normalized || ''
}

function getStableSynergyAltKey(synergyAlt, synergyHeaderId = '') {
    let headerId = String(synergyHeaderId || '').trim()
    let normalizedAlt = normalizeHeaderText(synergyAlt || '')
    if (!normalizedAlt) {
        return ''
    }

    if (!headerId && normalizedAlt.match(/^column\s+\d+$/i)) {
        return ''
    }

    return normalizeForMatch(normalizedAlt)
}

function getManualRowAlignmentKey(synergyAssignment, colIndex = '', synergyAlt = '', synergyHeaderId = '') {
    let synergyKey = getManualSynergyAssignmentKey(synergyAssignment)
    if (!synergyKey) {
        return ''
    }

    let altKey = getStableSynergyAltKey(synergyAlt, synergyHeaderId)
    if (altKey) {
        return `${synergyKey}::alt:${altKey}`
    }

    let colKey = String(colIndex || '').trim()
    if (!colKey) {
        return ''
    }

    return `${synergyKey}::col:${colKey}`
}

function getLegacyManualRowAlignmentKey(synergyAssignment, colIndex = '') {
    let synergyKey = getManualSynergyAssignmentKey(synergyAssignment)
    let colKey = String(colIndex || '').trim()
    if (!synergyKey || !colKey) {
        return ''
    }
    return `${synergyKey}::${colKey}`
}

function getEmptyManualAlignmentSet() {
    return {
        assignmentBySynergy: {},
        rowBySynergyCol: {}
    }
}

function normalizeManualAlignmentSet(rawSet) {
    let source = rawSet && typeof rawSet === 'object' ? rawSet : {}
    let normalized = getEmptyManualAlignmentSet()

    let assignmentBySynergy = ensurePlainObject(source.assignmentBySynergy)
    Object.keys(assignmentBySynergy).forEach((synergyKey) => {
        let normalizedKey = String(synergyKey || '').trim()
        let assignmentId = String(assignmentBySynergy[synergyKey] || '').trim()
        if (normalizedKey && assignmentId) {
            normalized.assignmentBySynergy[normalizedKey] = assignmentId
        }
    })

    let rowBySynergyCol = ensurePlainObject(source.rowBySynergyCol)
    Object.keys(rowBySynergyCol).forEach((rowKey) => {
        let row = rowBySynergyCol[rowKey]
        let normalizedRow = normalizeMappingRecord(row)
        let synergyKey = getManualSynergyAssignmentKey(normalizedRow.synergy_assignment)
        let colIndex = String(normalizedRow.col_index || '')
        let synergyAlt = String(normalizedRow.synergy_alt || '')
        let assignmentId = String(normalizedRow.assignment_id || '')
        let rubricId = String(normalizedRow.rubric_id || '')
        if (!synergyKey || !assignmentId || !rubricId) {
            return
        }
        let key = getManualRowAlignmentKey(
            normalizedRow.synergy_assignment,
            colIndex,
            synergyAlt,
            normalizedRow.synergy_header_id
        )
        if (!key) {
            // Backward compatibility for legacy key format keyed by col_index only.
            let legacyMatch = String(rowKey || '').match(/^(.*?)::(.+)$/)
            if (legacyMatch) {
                let legacySynergyKey = String(legacyMatch[1] || '').trim()
                let legacyColIndex = String(legacyMatch[2] || '').trim()
                let looksLegacyColIndex = Boolean(
                    legacyColIndex &&
                    !legacyColIndex.startsWith('alt:') &&
                    !legacyColIndex.startsWith('col:')
                )
                if (legacySynergyKey === synergyKey && looksLegacyColIndex) {
                    key = getManualRowAlignmentKey(normalizedRow.synergy_assignment, legacyColIndex, '')
                    if (!colIndex) {
                        colIndex = legacyColIndex
                    }
                }
            }
        }
        if (!key) {
            return
        }
        normalized.rowBySynergyCol[key] = {
            col_index: colIndex,
            synergy_assignment: normalizedRow.synergy_assignment,
            synergy_alt: synergyAlt,
            synergy_header_id: String(normalizedRow.synergy_header_id || ''),
            assignment_id: assignmentId,
            rubric_id: rubricId
        }
    })

    return normalized
}

function getStoredManualAlignmentsForPairKey(pairKey) {
    let key = String(pairKey || '')
    if (!key) {
        return getEmptyManualAlignmentSet()
    }
    let byPair = ensurePlainObject(mapperState.manualAlignmentsByPair)
    return normalizeManualAlignmentSet(byPair[key])
}

function setStoredManualAlignmentsForPairKey(pairKey, manualSet) {
    let key = String(pairKey || '')
    if (!key) {
        return
    }
    let byPair = ensurePlainObject(mapperState.manualAlignmentsByPair)
    byPair[key] = normalizeManualAlignmentSet(manualSet)
    mapperState.manualAlignmentsByPair = byPair
}

function syncMappingsFromCurrentPair() {
    let pairKey = getActiveSynergyCanvasPairKey()
    if (!pairKey) {
        return
    }

    let pairMappings = getStoredMappingsForPairKey(pairKey)
    if (pairMappings.length > 0) {
        mapperState.mappings = pairMappings
        return
    }

    // One-time migration path for older global mapping storage.
    if (Array.isArray(mapperState.mappings) && mapperState.mappings.length > 0) {
        setStoredMappingsForPairKey(pairKey, mapperState.mappings)
        suppressNextMappingsRefresh = true
        chrome.storage.local.set({
            [mapperMappingsByPairStorageKey]: mapperState.mappingsByPair
        })
    }
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

function escapeHtmlText(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function getCanvasAssignmentUrl(assignment) {
    if (!assignment || !assignment.id) {
        return ''
    }

    let directUrl = String(assignment.html_url || assignment.assignment_url || '').trim()
    if (directUrl) {
        return directUrl
    }

    let baseUrl = normalizeCanvasBaseUrl(mapperState.canvasBaseUrl || '')
    let courseId = String(assignment.course_id || mapperState.selectedCanvasCourseId || '').trim()
    let assignmentId = String(assignment.id || '').trim()
    if (!baseUrl || !courseId || !assignmentId) {
        return ''
    }

    return `${baseUrl}/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}`
}

function getCanvasAssignmentLinkLabel(assignment) {
    let label = normalizeHeaderText(assignment && assignment.name ? assignment.name : assignment && assignment.id ? assignment.id : '')
    return label
}

function getCanvasAssignmentFormattedLinkParts(assignment) {
    let url = getCanvasAssignmentUrl(assignment)
    let label = getCanvasAssignmentLinkLabel(assignment)
    if (!url || !label) {
        return null
    }

    return {
        html: `View in Canvas: <a href="${escapeHtmlText(url)}">${escapeHtmlText(label)}</a>`,
        text: `View in Canvas: ${label} ${url}`
    }
}

async function copyHtmlToClipboard(html, textFallback = '') {
    let safeHtml = String(html || '').trim()
    let safeText = String(textFallback || '').trim()
    if (!safeHtml) {
        return false
    }

    try {
        if (
            navigator.clipboard &&
            typeof navigator.clipboard.write === 'function' &&
            typeof ClipboardItem !== 'undefined'
        ) {
            await navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([safeHtml], { type: 'text/html' }),
                    'text/plain': new Blob([safeText || safeHtml], { type: 'text/plain' })
                })
            ])
            return true
        }
    } catch (e) {
        // fall through to legacy copy paths
    }

    try {
        let container = document.createElement('div')
        container.innerHTML = safeHtml
        container.setAttribute('contenteditable', 'true')
        container.style.position = 'fixed'
        container.style.left = '-9999px'
        container.style.top = '-9999px'
        container.style.opacity = '0'
        document.body.appendChild(container)

        let selection = window.getSelection()
        let range = document.createRange()
        range.selectNodeContents(container)
        selection.removeAllRanges()
        selection.addRange(range)
        let copied = document.execCommand('copy')
        selection.removeAllRanges()
        document.body.removeChild(container)
        if (copied) {
            return true
        }
    } catch (e) {
        // fall through to plain text
    }

    return copyTextToClipboard(safeText)
}

function getCanvasShortDate(value) {
    if (!value) {
        return ''
    }

    let parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return ''
    }

    return parsed.toLocaleDateString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric'
    })
}

function getSelectedCanvasAssignmentLabel(selectEl) {
    let selectedOption = selectEl.find('option:selected')
    let label = normalizeHeaderText(
        selectedOption.attr('data-full-label') || selectedOption.text()
    )
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
        mapperMappingsByPairStorageKey,
        manualAlignmentsByPairStorageKey,
        mapperStorageKey
    ])
    let sync = await chrome.storage.sync.get({
        roundUpFrom: 0.5,
        missingPref: 'skip'
    })

    mapperState.roundUpFrom = normalizeRoundUpFromValue(sync.roundUpFrom, 0.5)
    mapperState.missingPref = normalizeMissingPrefValue(sync.missingPref, 'skip')
    mapperState.sortMethod = normalizeMapperSortMethod(local[mapperSortMethodStorageKey], defaultMapperSortMethod)
    mapperState.mappings = normalizeMappingsArray(local[mapperStorageKey])
    mapperState.mappingsByPair = ensurePlainObject(local[mapperMappingsByPairStorageKey])
    mapperState.manualAlignmentsByPair = ensurePlainObject(local[manualAlignmentsByPairStorageKey])
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

    syncMappingsFromCurrentPair()
    updateMapperReadyUi()
}

function setCanvasCourseStatus(text, isError = false) {
    syncCanvasAuthStateFromStatus(text, isError)
    if (mapperState.canvasAuthRequired) {
        $('#bsd-canvas-course-status').text('')
        return
    }
    $('#bsd-canvas-course-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function setCanvasFetchStatus(text, isError = false) {
    syncCanvasAuthStateFromStatus(text, isError)
    if (mapperState.canvasAuthRequired) {
        $('#bsd-canvas-fetch-status').text('')
        return
    }
    $('#bsd-canvas-fetch-status')
        .css('color', isError ? '#f9b1b1' : '#b4f7fe')
        .text(text)
}

function isCanvasAuthRequiredMessage(text) {
    let normalized = String(text || '').trim().toLowerCase()
    if (!normalized) {
        return false
    }
    return (
        normalized.includes('canvas session expired or not authenticated') ||
        normalized.includes('user authorization required') ||
        normalized.includes('unauthenticated')
    )
}

function updateCanvasAuthRequiredUi() {
    let authRequired = Boolean(mapperState.canvasAuthRequired)
    $('#bsd-sidepanel').toggleClass('bsd-canvas-auth-required', authRequired)
    $('#bsd-canvas-auth-callout').toggleClass('bsd-hidden', !authRequired)
    $('.bsd-canvas-course-inline').toggleClass('bsd-hidden', authRequired)
    $('#bsd-canvas-assignment-summary').toggleClass('bsd-hidden', authRequired)
    $('#bsd-refresh-data').toggleClass('bsd-hidden', authRequired)
    $('#bsd-refresh-activity').toggleClass('bsd-hidden', authRequired || !refreshActionInFlight)
    $('#bsd-canvas-course-status').toggleClass('bsd-hidden', authRequired)
    $('#bsd-canvas-fetch-status').toggleClass('bsd-hidden', authRequired)
    $('#bsd-mapper-status').toggleClass('bsd-hidden', authRequired)
    $('#bsd-canvas-fetch-progress').toggleClass(
        'bsd-hidden',
        authRequired || canvasFetchProgressState.total <= 0
    )
    if (authRequired) {
        $('#bsd-mapper-status').text('')
        $('#bsd-no-submissions-callout').addClass('bsd-hidden')
    }
}

function setCanvasAuthRequired(active) {
    mapperState.canvasAuthRequired = Boolean(active)
    if (mapperState.canvasAuthRequired) {
        mapperState.assignmentHelperExpanded = false
    }
    updateCanvasAuthRequiredUi()
}

function syncCanvasAuthStateFromStatus(text, isError = false) {
    let shouldRequireAuth = Boolean(isError && isCanvasAuthRequiredMessage(text))
    if (shouldRequireAuth !== Boolean(mapperState.canvasAuthRequired)) {
        setCanvasAuthRequired(shouldRequireAuth)
    }
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

function updatePrimaryRefreshButtonUi() {
    let button = $('#bsd-refresh-data')
    if (button.length === 0) {
        return
    }

    let hasCourse = hasSelectedCanvasCourse()
    let hasFetched = hasCourse && hasFetchedSubmissionsReady()
    let isFetchMode = !hasFetched

    button
        .text('Refresh')
        .toggleClass('bsd-fetch-mode', isFetchMode)
        .attr(
            'title',
            isFetchMode
                ? 'Fetch Canvas scores and submissions for the selected course.'
                : 'Refresh Synergy context and re-run auto-match.'
        )
}

function updateCanvasActionButtons() {
    let hasCourse = Boolean(String($('#bsd-canvas-course-select').val() || mapperState.selectedCanvasCourseId || ''))
    let controlsDisabled = canvasFetchInFlight || refreshActionInFlight
    let hasAssignments = getCachedAssignmentsForSelectedCourse().length > 0
    let authRequired = Boolean(mapperState.canvasAuthRequired)

    $('#bsd-load-canvas-courses').prop('disabled', controlsDisabled)
    $('#bsd-canvas-course-select').prop('disabled', controlsDisabled)
    $('#bsd-refresh-data').prop('disabled', authRequired || !hasCourse || controlsDisabled)
    $('#bsd-copy-canvas-assignment').prop('disabled', controlsDisabled || !hasAssignments)
    $('#bsd-toggle-assignment-helper').prop('disabled', controlsDisabled || !hasAssignments)
    updateCopyCanvasAssignmentHelperUi()
    updatePrimaryRefreshButtonUi()
    updateCanvasAuthRequiredUi()
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
        let normalizedBody = String(body || '').toLowerCase()
        if (
            response.status === 401 ||
            normalizedBody.includes('unauthenticated') ||
            normalizedBody.includes('authorization required')
        ) {
            throw new Error('Canvas session expired or not authenticated. Open a logged-in Canvas tab, then try again.')
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
    mapperState.canvasCourseFilter = ''
    let filteredCourses = mapperState.canvasCourses.slice()

    let selectedCourseId = String(mapperState.selectedCanvasCourseId || '')
    if (selectedCourseId && !filteredCourses.some((course) => String(course.id) === selectedCourseId)) {
        let selectedCourse = mapperState.canvasCourses.find((course) => String(course.id) === selectedCourseId)
        if (selectedCourse) {
            filteredCourses.unshift(selectedCourse)
        }
    }

    let select = $('#bsd-canvas-course-select')
    select.empty()
    select.append('<option value="">Choose Canvas course</option>')

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

function renderCopyCanvasAssignmentOptions() {
    let select = $('#bsd-copy-canvas-assignment')
    if (select.length === 0) {
        return
    }

    let assignments = getCachedAssignmentsForSelectedCourse()
    let selectedCourseId = String(mapperState.selectedCanvasCourseId || '')
    let previousValue = String(select.val() || '')
    let controlsDisabled = canvasFetchInFlight || refreshActionInFlight

    select.empty()

    let placeholder = 'Choose Canvas assignment title'
    if (!selectedCourseId) {
        placeholder = 'Select Canvas course first'
    } else if (assignments.length === 0) {
        placeholder = 'Load Canvas assignments first'
    }

    select.append(
        $('<option></option>')
            .attr('value', '')
            .text(placeholder)
    )

    assignments.forEach((assignment) => {
        let assignmentId = String(assignment && assignment.id ? assignment.id : '')
        if (!assignmentId) {
            return
        }

        select.append(
            $('<option></option>')
                .attr('value', assignmentId)
                .text(String(assignment && assignment.name ? assignment.name : assignmentId))
        )
    })

    if (previousValue && assignments.some((assignment) => String(assignment.id) === previousValue)) {
        select.val(previousValue)
    }

    select.prop('disabled', controlsDisabled || assignments.length === 0)
    updateCopyCanvasAssignmentHelperUi()
}

function updateCopyCanvasAssignmentHelperUi() {
    let helper = $('#bsd-assignment-helper')
    let toggle = $('#bsd-toggle-assignment-helper')
    let body = $('#bsd-assignment-helper-body')
    if (helper.length === 0 || toggle.length === 0 || body.length === 0) {
        return
    }

    let hasAssignments = getCachedAssignmentsForSelectedCourse().length > 0
    if (!hasAssignments) {
        mapperState.assignmentHelperExpanded = false
    }

    let expanded = Boolean(mapperState.assignmentHelperExpanded && hasAssignments)
    toggle.text(expanded ? 'Hide Assignment Helper' : 'Show Assignment Helper')
    body.toggleClass('bsd-hidden', !expanded)
    helper.toggleClass('bsd-assignment-helper-open', expanded)
}

function renderCopyCanvasAssignmentDetails() {
    let panel = $('#bsd-copy-canvas-assignment-details')
    let nameEl = $('#bsd-copy-canvas-assignment-name')
    let linkRowEl = $('#bsd-copy-canvas-assignment-link-row')
    let linkEl = $('#bsd-copy-canvas-assignment-link')
    let copyNameButton = $('#bsd-copy-canvas-assignment-copy-name')
    let copyAssignDateButton = $('#bsd-copy-canvas-assignment-copy-assign-date')
    let copyDueDateButton = $('#bsd-copy-canvas-assignment-copy-due-date')
    let copyUrlButton = $('#bsd-copy-canvas-assignment-copy-url')
    let copyFormattedLinkButton = $('#bsd-copy-canvas-assignment-copy-formatted-link')
    let metaEl = $('#bsd-copy-canvas-assignment-meta')
    let outcomesEl = $('#bsd-copy-canvas-assignment-outcomes')
    if (
        panel.length === 0 ||
        nameEl.length === 0 ||
        linkRowEl.length === 0 ||
        linkEl.length === 0 ||
        copyNameButton.length === 0 ||
        copyAssignDateButton.length === 0 ||
        copyDueDateButton.length === 0 ||
        copyUrlButton.length === 0 ||
        copyFormattedLinkButton.length === 0 ||
        metaEl.length === 0 ||
        outcomesEl.length === 0
    ) {
        return
    }

    metaEl.empty()
    outcomesEl.empty()

    let assignmentId = String(mapperState.copiedCanvasAssignmentId || '')
    let assignments = getCachedAssignmentsForSelectedCourse()
    let assignment = assignmentId ? getAssignmentById(assignments, assignmentId) : null
    if (!assignment) {
        mapperState.copiedCanvasAssignmentId = ''
        nameEl.text('')
        linkEl.attr('href', '#').removeAttr('title')
        linkEl.addClass('bsd-hidden')
        copyNameButton.prop('disabled', true)
        copyAssignDateButton.prop('disabled', true)
        copyDueDateButton.prop('disabled', true)
        copyUrlButton.prop('disabled', true)
        copyFormattedLinkButton.prop('disabled', true)
        linkRowEl.addClass('bsd-hidden')
        panel.addClass('bsd-hidden')
        return
    }

    let submissionsByAssignment = getStoredSubmissionsByAssignmentForCourse(assignments)
    let submissions = Array.isArray(submissionsByAssignment[assignmentId]) ? submissionsByAssignment[assignmentId] : []
    let rubrics = getRubrics(assignment)
    let assignmentLabel = getCanvasAssignmentLinkLabel(assignment)
    let assignmentUrl = getCanvasAssignmentUrl(assignment)
    let shortAssignDate = getCanvasShortDate(assignment.created_at)
    let shortDueDate = getCanvasShortDate(assignment.due_at)

    nameEl.text(String(assignment.name || assignmentId))

    if (assignmentUrl) {
        linkEl.attr('href', assignmentUrl).attr('title', assignmentUrl)
        linkEl.removeClass('bsd-hidden')
    } else {
        linkEl.attr('href', '#').removeAttr('title')
        linkEl.addClass('bsd-hidden')
    }
    linkRowEl.toggleClass('bsd-hidden', !assignmentLabel && !assignmentUrl && !shortAssignDate && !shortDueDate)
    copyNameButton.prop('disabled', !assignmentLabel)
    copyAssignDateButton.prop('disabled', !shortAssignDate)
    copyDueDateButton.prop('disabled', !shortDueDate)
    copyUrlButton.prop('disabled', !assignmentUrl)
    copyFormattedLinkButton.prop('disabled', !assignmentUrl)

    let metaItems = [
        {
            label: 'Last updated',
            value: getAssignmentUpdatedText(assignment)
        },
        {
            label: 'Submissions',
            value: String(submissions.length)
        },
        {
            label: 'Points',
            value: assignment.points_possible == null ? '-' : String(assignment.points_possible)
        },
        {
            label: 'Due',
            value: formatCanvasDateTime(assignment.due_at)
        }
    ]

    metaItems.forEach((item) => {
        let chip = $('<div class="bsd-copy-assignment-meta-item"></div>')
        chip.append($('<span class="bsd-copy-assignment-meta-label"></span>').text(`${item.label}:`))
        chip.append($('<span></span>').text(String(item.value || '-')))
        metaEl.append(chip)
    })

    if (rubrics.length === 0) {
        outcomesEl.append(
            $('<li class="bsd-copy-assignment-empty"></li>').text('No Canvas targets on this assignment.')
        )
    } else {
        rubrics.forEach((rubric) => {
            let item = $('<li></li>').text(getRubricOptionLabel(rubric))
            let matchText = getRubricMatchText(rubric)
            if (matchText) {
                item.attr('title', matchText)
            }
            outcomesEl.append(item)
        })
    }

    panel.removeClass('bsd-hidden')
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
    renderCopyCanvasAssignmentOptions()
    renderCopyCanvasAssignmentDetails()
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
    let loginId = normalizeSynergyId(user && user.login_id)
    return loginId ? [loginId] : []
}

async function fetchCanvasStudentMatchIdsForCourse(courseId, baseUrl) {
    let page = 1
    let perPage = 100
    let matchIds = []
    let seen = new Set()

    while (true) {
        let users = await fetchCanvasJson(
            baseUrl,
            `/api/v1/courses/${courseId}/users?enrollment_type[]=student&per_page=${perPage}&page=${page}`
        )

        if (!Array.isArray(users) || users.length === 0) {
            break
        }

        users.forEach((user) => {
            let ids = getCanvasUserCourseMatchIds(user)
            ids.forEach((id) => {
                if (!seen.has(id)) {
                    seen.add(id)
                    matchIds.push(id)
                }
            })
        })

        if (users.length < perPage) {
            break
        }
        page += 1
    }

    return matchIds
}

async function filterCanvasCoursesBySynergyRoster(courses, baseUrl, synergyStudentIds) {
    if (!Array.isArray(courses) || courses.length === 0) {
        return {
            courses: [],
            matchCountsByCourseId: {},
            bestMatchedCourseId: '',
            bestMatchedCourseCount: 0
        }
    }

    let synergyIdSet = getSynergyStudentIdSet(synergyStudentIds)
    if (synergyIdSet.size === 0) {
        return {
            courses: courses.slice(),
            matchCountsByCourseId: {},
            bestMatchedCourseId: '',
            bestMatchedCourseCount: 0
        }
    }

    let matchCountsByCourseId = {}
    let matchedCourseRows = []
    let nextCourseIndex = 0
    let completedCourses = 0
    let activeCourses = 0
    let workerCount = Math.max(1, Math.min(canvasCourseRosterMatchConcurrency, courses.length))

    function updateCourseRosterMatchStatus(activeCourseName = '') {
        let label = `Matching Canvas rosters: ${completedCourses}/${courses.length} checked`
        if (activeCourses > 0) {
            label += `, ${activeCourses} in progress`
        }
        if (activeCourseName) {
            label += `: ${activeCourseName}`
        }
        setCanvasCourseStatus(label)
    }

    async function matchCourseWorker() {
        while (nextCourseIndex < courses.length) {
            let queueIndex = nextCourseIndex
            nextCourseIndex += 1

            let course = courses[queueIndex]
            if (!course || !course.id) {
                completedCourses += 1
                updateCourseRosterMatchStatus()
                continue
            }

            activeCourses += 1
            updateCourseRosterMatchStatus(course.name)

            try {
                let matchIds = await fetchCanvasStudentMatchIdsForCourse(course.id, baseUrl)
                let matchCount = 0
                matchIds.forEach((id) => {
                    if (synergyIdSet.has(id)) {
                        matchCount += 1
                    }
                })

                matchCountsByCourseId[String(course.id)] = matchCount
                if (matchCount > 0) {
                    matchedCourseRows.push({
                        course: {
                            ...course,
                            student_match_count: matchCount
                        },
                        matchCount: matchCount
                    })
                }
            } catch (e) {
                if (isAbortError(e)) {
                    throw e
                }
                matchCountsByCourseId[String(course.id)] = 0
                // Skip courses we cannot inspect and continue matching the rest.
            } finally {
                activeCourses = Math.max(0, activeCourses - 1)
                completedCourses += 1
                updateCourseRosterMatchStatus()
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => matchCourseWorker()))

    matchedCourseRows.sort((a, b) => {
        if (b.matchCount !== a.matchCount) {
            return b.matchCount - a.matchCount
        }
        let nameCompare = String(a.course && a.course.name ? a.course.name : '').localeCompare(
            String(b.course && b.course.name ? b.course.name : '')
        )
        if (nameCompare !== 0) {
            return nameCompare
        }
        return String(a.course && a.course.term_name ? a.course.term_name : '').localeCompare(
            String(b.course && b.course.term_name ? b.course.term_name : '')
        )
    })

    let bestMatchedCourse = matchedCourseRows.length > 0 ? matchedCourseRows[0] : null
    return {
        courses: matchedCourseRows.map((row) => row.course),
        matchCountsByCourseId: matchCountsByCourseId,
        bestMatchedCourseId: bestMatchedCourse && bestMatchedCourse.course ? String(bestMatchedCourse.course.id || '') : '',
        bestMatchedCourseCount: bestMatchedCourse ? bestMatchedCourse.matchCount : 0
    }
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
    let perPage = 50
    let rowsByPage = {}

    setCanvasCourseStatus('Fetching assignments (page 1)...')
    let firstPageData = await fetchCanvasJson(
        baseUrl,
        `/api/v1/courses/${courseId}/assignments?include[]=rubric&order_by=due_at&per_page=${perPage}&page=1`
    )
    rowsByPage[1] = Array.isArray(firstPageData) ? firstPageData : []

    if (rowsByPage[1].length === perPage) {
        let workerCount = Math.max(1, Math.min(canvasAssignmentsFetchConcurrency, 8))
        let nextPage = 2
        let stopPageExclusive = Number.POSITIVE_INFINITY

        async function fetchPageWorker(workerId) {
            while (true) {
                if (nextPage >= stopPageExclusive) {
                    return
                }

                let page = nextPage
                nextPage += 1

                setCanvasCourseStatus(`Fetching assignments (page ${page}, worker ${workerId})...`)

                let pageData = await fetchCanvasJson(
                    baseUrl,
                    `/api/v1/courses/${courseId}/assignments?include[]=rubric&order_by=due_at&per_page=${perPage}&page=${page}`
                )
                let rows = Array.isArray(pageData) ? pageData : []
                rowsByPage[page] = rows

                if (rows.length === 0) {
                    stopPageExclusive = Math.min(stopPageExclusive, page)
                } else if (rows.length < perPage) {
                    stopPageExclusive = Math.min(stopPageExclusive, page + 1)
                }
            }
        }

        let workers = []
        for (let i = 0; i < workerCount; i++) {
            workers.push(fetchPageWorker(i + 1))
        }
        await Promise.all(workers)
    }

    let allRows = []
    Object.keys(rowsByPage)
        .map((pageKey) => Number(pageKey))
        .filter((page) => Number.isFinite(page))
        .sort((a, b) => a - b)
        .forEach((page) => {
            let rows = rowsByPage[page]
            if (Array.isArray(rows) && rows.length > 0) {
                allRows.push(...rows)
            }
        })

    let assignments = []
    allRows.forEach((item) => {
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
            html_url: String(item.html_url || ''),
            use_rubric_for_grading: Boolean(item.use_rubric_for_grading),
            points_possible: item.points_possible,
            rubric: rubric,
            due_at: item.due_at,
            created_at: item.created_at,
            updated_at: item.updated_at
        })
    })

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
        let includeConcluded = false
        mapperState.canvasIncludeConcludedCourses = false

        let baseUrl = await ensureCanvasBaseUrl(forceFromTabs)
        let allCourses = await fetchCanvasCourses(baseUrl, includeConcluded)
        let courses = allCourses
        let rosterMatchResult = null
        let rosterFilterApplied = false
        let usedStoredMatch = false
        let synergyRosterSize = 0

        let synergyStudentIds = []
        try {
            synergyStudentIds = await getSynergyStudentIdsForCourseFilter()
            synergyRosterSize = getSynergyStudentIdSet(synergyStudentIds).size
        } catch (e) {
            synergyStudentIds = []
            synergyRosterSize = 0
        }

        let storedMatch = getStoredCanvasCourseMatchForCurrentSynergyCourse()
        let storedCanvasCourseId = String(storedMatch && storedMatch.canvasCourseId ? storedMatch.canvasCourseId : '')
        if (storedCanvasCourseId) {
            usedStoredMatch = true
        }

        if (synergyStudentIds.length > 0 && !usedStoredMatch) {
            rosterFilterApplied = true
            rosterMatchResult = await filterCanvasCoursesBySynergyRoster(allCourses, baseUrl, synergyStudentIds)
            courses = rosterMatchResult.courses
        } else if (synergyStudentIds.length > 0 && usedStoredMatch) {
            let storedExists = allCourses.some((course) => String(course.id) === storedCanvasCourseId)
            if (!storedExists) {
                usedStoredMatch = false
                rosterFilterApplied = true
                rosterMatchResult = await filterCanvasCoursesBySynergyRoster(allCourses, baseUrl, synergyStudentIds)
                courses = rosterMatchResult.courses
            }
        }

        mapperState.canvasCourses = courses

        let selectedFromStoredMatch = ''
        if (usedStoredMatch && storedCanvasCourseId && courses.some((course) => String(course.id) === storedCanvasCourseId)) {
            selectedFromStoredMatch = storedCanvasCourseId
        }
        let bestMatchedCourseId = String(
            rosterMatchResult && rosterMatchResult.bestMatchedCourseId ? rosterMatchResult.bestMatchedCourseId : ''
        )
        if (selectedFromStoredMatch) {
            mapperState.selectedCanvasCourseId = selectedFromStoredMatch
        } else if (bestMatchedCourseId && courses.some((course) => String(course.id) === bestMatchedCourseId)) {
            mapperState.selectedCanvasCourseId = bestMatchedCourseId
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
                let selectedCourseId = String(mapperState.selectedCanvasCourseId || '')
                let selectedCourseName = getCanvasCourseNameForId(selectedCourseId, courses)
                let selectedMatchCount = Number(
                    rosterMatchResult &&
                    rosterMatchResult.matchCountsByCourseId &&
                    Number.isFinite(rosterMatchResult.matchCountsByCourseId[selectedCourseId])
                        ? rosterMatchResult.matchCountsByCourseId[selectedCourseId]
                        : 0
                )
                let matchPercent = synergyRosterSize > 0
                    ? Math.round((selectedMatchCount / synergyRosterSize) * 100)
                    : 0

                if (selectedCourseName && synergyRosterSize > 0) {
                    filterText = ` ${selectedCourseName} had ${selectedMatchCount}/${synergyRosterSize} students matched (${matchPercent}%).`
                } else {
                    filterText = ` Matched ${courses.length}/${allCourses.length} course(s) to the current Synergy roster.`
                }
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
                noCoursesText = 'No Canvas courses matched any students from the current Synergy class.'
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
    mapperState.copiedCanvasAssignmentId = ''
    syncMappingsFromCurrentPair()

    let firstSubmissions = getFirstSubmissionsForAssignments(mapperState.assignments, mapperState.submissionsByAssignment)
    suppressNextMappingsRefresh = true
    await chrome.storage.local.set({
        canvasCourseId: safeCourseId,
        assignments: mapperState.assignments,
        submissionsByAssignment: mapperState.submissionsByAssignment,
        submissions: firstSubmissions,
        [mapperStorageKey]: normalizeMappingsArray(mapperState.mappings)
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
        if (Array.isArray(mapperState.mappings) && mapperState.mappings.length > 0) {
            setMapperStatus(`Canvas course changed. Restored ${mapperState.mappings.length} saved alignment row(s) for this course pair.`)
        } else {
            setMapperStatus('Canvas course changed. No saved alignments found for this course pair.')
        }
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

function getSynergyColumnByHeaderId(headerId) {
    let wanted = String(headerId || '').trim()
    if (!wanted) {
        return null
    }
    let columns = getVisibleSynergyColumns()
    for (let i = 0; i < columns.length; i++) {
        if (String(columns[i].header_id || '').trim() === wanted) {
            return columns[i]
        }
    }
    return null
}

function getSynergyColumnAltText(column) {
    if (!column || typeof column !== 'object') {
        return ''
    }
    return normalizeHeaderText(column.alt_label || column.label || '')
}

function getResolvedSynergyAssignmentForColumn(column, groupedColumns = null) {
    if (!column || typeof column !== 'object') {
        return ''
    }
    let grouped = groupedColumns || getSynergyColumnsByAssignment()
    let raw = cleanSynergyAssignmentLabel(column.assignment_label || '')
    let resolved = resolveSynergyAssignmentName(raw, grouped)
    return resolved || raw
}

function doesSynergyColumnMatchStoredMapping(column, mapping, groupedColumns = null) {
    if (!column || !mapping) {
        return false
    }

    let stored = normalizeMappingRecord(mapping)
    let storedHeaderId = String(stored.synergy_header_id || '').trim()
    let storedAssignment = cleanSynergyAssignmentLabel(stored.synergy_assignment || '')
    let resolvedStoredAssignment = resolveStoredSynergyAssignmentName(storedAssignment, groupedColumns)
    let storedAltKey = getStableSynergyAltKey(stored.synergy_alt, storedHeaderId)

    if (storedHeaderId && String(column.header_id || '').trim() !== storedHeaderId) {
        return false
    }

    if (resolvedStoredAssignment) {
        let columnAssignment = getResolvedSynergyAssignmentForColumn(column, groupedColumns)
        if (columnAssignment !== resolvedStoredAssignment) {
            return false
        }
    }

    if (storedAltKey) {
        let columnAltKey = normalizeForMatch(getSynergyColumnAltText(column))
        if (!columnAltKey || columnAltKey !== storedAltKey) {
            return false
        }
    }

    return true
}

function resolveSynergyColumnForStoredMapping(mapping, groupedColumns = null) {
    let stored = normalizeMappingRecord(mapping)
    let grouped = groupedColumns || getSynergyColumnsByAssignment()
    let storedColIndex = String(stored.col_index || '').trim()
    let storedHeaderId = String(stored.synergy_header_id || '').trim()
    let storedAssignment = cleanSynergyAssignmentLabel(stored.synergy_assignment || '')
    let resolvedAssignment = resolveStoredSynergyAssignmentName(storedAssignment, grouped)
    let storedAlt = normalizeHeaderText(stored.synergy_alt || '')
    let storedAltKey = getStableSynergyAltKey(storedAlt, storedHeaderId)
    let byIndex = storedColIndex ? getSynergyColumnByIndex(storedColIndex) : null

    let assignmentColumns = []
    if (resolvedAssignment && Array.isArray(grouped[resolvedAssignment])) {
        assignmentColumns = grouped[resolvedAssignment]
    }

    if (storedHeaderId) {
        let byHeaderId = getSynergyColumnByHeaderId(storedHeaderId)
        if (byHeaderId && doesSynergyColumnMatchStoredMapping(byHeaderId, stored, grouped)) {
            return byHeaderId
        }
    }

    if (storedAltKey && assignmentColumns.length > 0) {
        let exactAltMatches = assignmentColumns.filter((column) => {
            return normalizeForMatch(getSynergyColumnAltText(column)) === storedAltKey
        })
        if (exactAltMatches.length === 1) {
            return exactAltMatches[0]
        }
        if (
            exactAltMatches.length > 1 &&
            byIndex &&
            exactAltMatches.some((column) => String(column.col_index || '') === String(byIndex.col_index || ''))
        ) {
            return byIndex
        }
        return null
    }

    if (!storedHeaderId && !storedAltKey && assignmentColumns.length === 1) {
        return assignmentColumns[0]
    }

    return null
}

function reconcileStoredMappingToVisibleColumns(mapping, groupedColumns = null) {
    let normalized = normalizeMappingRecord(mapping)
    let grouped = groupedColumns || getSynergyColumnsByAssignment()
    let column = resolveSynergyColumnForStoredMapping(normalized, grouped)

    if (!column) {
        normalized.col_index = ''
        return normalized
    }

    normalized.col_index = String(column.col_index || '')
    normalized.synergy_header_id = String(column.header_id || normalized.synergy_header_id || '')
    normalized.synergy_assignment = getResolvedSynergyAssignmentForColumn(column, grouped) || normalized.synergy_assignment
    normalized.synergy_alt = normalizeHeaderText(normalized.synergy_alt || getSynergyColumnAltText(column))

    return normalized
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

function resolveStoredSynergyAssignmentName(selectedSynergyAssignment, groupedColumns = null) {
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

function updateCopyCanvasAssignmentVisibility() {
    let hasCourse = hasSelectedCanvasCourse()
    let hasFetched = hasCourse && hasFetchedSubmissionsReady()
    let showCopyAssignment = hasFetched && !refreshActionInFlight && !mapperState.canvasAuthRequired
    $('#bsd-assignment-helper').toggleClass('bsd-hidden', !showCopyAssignment)
    updateCopyCanvasAssignmentHelperUi()
}

function updateMapperReadyUi() {
    let hasCourse = hasSelectedCanvasCourse()
    let hasFetched = hasCourse && hasFetchedSubmissionsReady()
    let ready = hasCourse && hasFetched
    let assignmentsLoaded = hasCourse && getCachedAssignmentsForSelectedCourse().length > 0
    let showFetchPrompt = assignmentsLoaded && !hasFetched && !canvasFetchInFlight && !mapperState.canvasAuthRequired

    $('.bsd-panel-settings').toggleClass('bsd-no-submissions', !ready)
    $('.bsd-sort-controls').toggleClass('bsd-no-submissions', !ready)
    $('.bsd-step-4-controls').toggleClass('bsd-no-submissions', !ready)
    $('#bsd-map-cards').toggleClass('bsd-no-submissions', !ready)
    $('#bsd-no-submissions-callout').toggleClass('bsd-hidden', !showFetchPrompt)
    updateCopyCanvasAssignmentVisibility()
    updatePrimaryRefreshButtonUi()
    updateCourseStepUi()
    updateCanvasAuthRequiredUi()
}

function buildSynergyAssignmentOptions(selectEl, selectedSynergyAssignment) {
    let grouped = getSynergyColumnsByAssignment()
    let assignments = Object.keys(grouped).sort((a, b) => a.localeCompare(b))
    let resolvedSelected = resolveStoredSynergyAssignmentName(selectedSynergyAssignment, grouped)

    selectEl.empty()
    selectEl.append('<option value="">Choose Synergy assignment</option>')
    assignments.forEach((assignmentLabel) => {
        let option = $('<option></option>')
            .attr('value', assignmentLabel)
            .attr('title', assignmentLabel)
            .attr('data-full-label', assignmentLabel)
            .text(truncateText(assignmentLabel, 28))
        if (resolvedSelected && resolvedSelected === assignmentLabel) {
            option.attr('selected', true)
        }
        selectEl.append(option)
    })
}

function buildSynergyAltOptions(selectEl, selectedSynergyAssignment, selectedColIndex) {
    let grouped = getSynergyColumnsByAssignment()
    let resolvedAssignment = resolveStoredSynergyAssignmentName(selectedSynergyAssignment, grouped)
    let columns = []
    if (resolvedAssignment && grouped[resolvedAssignment]) {
        columns = grouped[resolvedAssignment]
    } else if (selectedColIndex) {
        let selectedColumn = getSynergyColumnByIndex(selectedColIndex)
        let columnAssignment = selectedColumn ? resolveStoredSynergyAssignmentName(selectedColumn.assignment_label, grouped) : ''
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
            .attr('data-header-id', String(column.header_id || ''))
            .attr('title', displayAlt)
            .attr('data-full-label', displayAlt)
            .text(truncateText(displayAlt, 28))
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
                .attr('data-header-id', '')
                .attr('title', `[${selected}] Column ${selected}`)
                .attr('data-full-label', `[${selected}] Column ${selected}`)
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
        let label = String(assignment.name || key)
        let option = $('<option></option>')
            .attr('value', key)
            .attr('title', label)
            .attr('data-full-label', label)
            .text(truncateText(label, 28))
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
            .attr('data-full-label', optionLabel)
            .text(truncateText(optionLabel, 28))
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
    let resolvedAssignment = resolveStoredSynergyAssignmentName(synergyAssignment)
    if (resolvedAssignment) {
        synergyAssignment = resolvedAssignment
    }
    let assignmentId = String(safe.assignment_id || '')
    let rows = []

    if (Array.isArray(safe.rows)) {
        safe.rows.forEach((row) => {
            rows.push({
                col_index: String((row && row.col_index) || ''),
                rubric_id: String((row && row.rubric_id) || ''),
                preserve_blank_target: Boolean(row && row.preserve_blank_target)
            })
        })
    } else if (selectedCol || safe.rubric_id) {
        rows.push({
            col_index: selectedCol,
            rubric_id: String(safe.rubric_id || ''),
            preserve_blank_target: Boolean(safe.preserve_blank_target)
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
    let preserveBlankTarget = Boolean(rowData && rowData.preserve_blank_target)

    let row = $(`
        <div class="bsd-map-row" data-row-id="${mappingRowCounter}">
            <div class="bsd-row-field bsd-row-field-synergy">
                <select class="bsd-syn-alt-select"></select>
            </div>
            <div class="bsd-row-field bsd-row-field-canvas">
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
    if (!synAltSelect.val() && !preserveBlankTarget) {
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
        rememberManualRowAlignment(row)
        persistMappingsFromUi()
    })

    canvasAltSelect.on('change', () => {
        clearInlineMappingErrors(card)
        updateCardPasteStates(card)
        rememberManualRowAlignment(row)
        persistMappingsFromUi()
    })

    row.find('.bsd-row-remove').on('click', () => {
        clearInlineMappingErrors(card)
        forgetManualRowAlignment(row)
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
    updateTrackedManualAlignmentKeysForRow(row)
}

function createMapperCard(cardData = {}) {
    mappingCardCounter += 1
    let normalized = normalizeCardSeedData(cardData)

    let card = $(`
        <div class="bsd-map-card" data-card-id="${mappingCardCounter}">
            <div class="bsd-assignment-wrap">
                <div class="bsd-section-head bsd-assignment-head">
                    <div class="bsd-standards-title">Assignment</div>
                </div>
                <div class="bsd-card-assignment-row">
                    <div class="bsd-card-assignment-field bsd-card-assignment-field-synergy">
                        <select class="bsd-card-syn-assign-select"></select>
                    </div>
                    <div class="bsd-card-assignment-field bsd-card-assignment-field-canvas">
                        <select class="bsd-card-canvas-assign-select"></select>
                    </div>
                    <div class="bsd-card-assignment-actions">
                        <button class="bsd-card-paste" type="button">Paste</button>
                        <button class="bsd-card-remove bsd-x-remove" type="button" title="Remove assignment">x</button>
                    </div>
                </div>
                <div class="bsd-card-assignment-meta-row">
                    <div class="bsd-card-assignment-meta bsd-card-assignment-meta-synergy">
                        <span class="bsd-inline-label">Synergy</span>
                    </div>
                    <div class="bsd-card-assignment-meta bsd-card-assignment-meta-canvas">
                        <span class="bsd-inline-label">Canvas</span>
                        <span class="bsd-card-assignment-meta-sep" aria-hidden="true">|</span>
                        <span class="bsd-inline-label">last updated:</span>
                        <div class="bsd-canvas-updated">-</div>
                    </div>
                    <div class="bsd-card-assignment-actions bsd-card-assignment-actions-placeholder" aria-hidden="true">
                        <button class="bsd-card-paste" type="button" tabindex="-1">Paste</button>
                        <button class="bsd-card-remove bsd-x-remove" type="button" tabindex="-1">x</button>
                    </div>
                </div>
            </div>
            <div class="bsd-standards-wrap">
                <div class="bsd-section-head bsd-standards-head">
                    <div class="bsd-standards-title">Standards</div>
                </div>
                <div class="bsd-card-rows"></div>
                <div class="bsd-card-rows-footer">
                    <span class="bsd-inline-label bsd-card-rows-footer-synergy-label">Synergy</span>
                    <span class="bsd-inline-label bsd-card-rows-footer-canvas-label">Canvas</span>
                    <div class="bsd-row-buttons bsd-row-buttons-placeholder" aria-hidden="true">
                        <button class="bsd-row-paste" type="button" tabindex="-1">Paste</button>
                        <button class="bsd-row-remove bsd-x-remove" type="button" tabindex="-1">x</button>
                    </div>
                </div>
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
        rememberManualAssignmentAlignment(card)
        persistMappingsFromUi()
    })

    card.find('.bsd-card-remove').on('click', () => {
        forgetManualAssignmentAlignment(card)
        card.remove()
        persistMappingsFromUi()
    })

    card.find('.bsd-card-paste').on('click', async () => {
        let rows = getRowsForCard(card)
        if (rows.length === 0) {
            setMapperStatus('No ALT rows found for this assignment.', true)
            return
        }

        let tab = await resolveSynergyTab()
        if (!tab) {
            setMapperStatus('Open a Synergy gradebook tab before pasting.', true)
            return
        }
        mapperState.activeTabId = tab.id
        mapperState.activeTabUrl = tab.url || ''

        for (let i = 0; i < rows.length; i++) {
            await pasteSingleRow($(rows[i]), tab)
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

    let groupedColumns = getSynergyColumnsByAssignment()
    let grouped = {}
    mappings.forEach((mapping) => {
        let reconciled = reconcileStoredMappingToVisibleColumns(mapping, groupedColumns)
        let colIndex = String(reconciled.col_index || '')
        let column = colIndex ? getSynergyColumnByIndex(colIndex) : null
        let derivedAssignment = cleanSynergyAssignmentLabel(reconciled.synergy_assignment || (column ? column.assignment_label : ''))
        let resolvedAssignment = resolveStoredSynergyAssignmentName(derivedAssignment, groupedColumns)
        if (resolvedAssignment) {
            derivedAssignment = resolvedAssignment
        }
        let groupKey = derivedAssignment || `unassigned_${Object.keys(grouped).length}`

        if (!grouped[groupKey]) {
            grouped[groupKey] = {
                synergy_assignment: derivedAssignment,
                assignment_id: String(reconciled.assignment_id || ''),
                rows: []
            }
        }

        if (!grouped[groupKey].assignment_id && reconciled.assignment_id) {
            grouped[groupKey].assignment_id = String(reconciled.assignment_id)
        }

        let rowExists = grouped[groupKey].rows.some((row) => {
            if (colIndex) {
                return String(row.col_index || '') === colIndex
            }
            return (
                !String(row.col_index || '') &&
                String(row.rubric_id || '') === String(reconciled.rubric_id || '')
            )
        })
        if (rowExists) {
            return
        }

        grouped[groupKey].rows.push({
            col_index: colIndex,
            rubric_id: String(reconciled.rubric_id || ''),
            preserve_blank_target: !colIndex
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
                synergy_header_id: String(selectedSynAltOption.attr('data-header-id') || ''),
                assignment_id: canvasAssignmentId,
                rubric_id: row.find('.bsd-canvas-alt-select').val()
            })
        })
    })
    return mappings
}

function persistMappingsToStorage(mappings, includePairStore = true) {
    let normalized = normalizeMappingsArray(mappings)
    mapperState.mappings = normalized

    let payload = {
        [mapperStorageKey]: normalized
    }
    let pairKey = getActiveSynergyCanvasPairKey()
    if (includePairStore && pairKey) {
        setStoredMappingsForPairKey(pairKey, normalized)
        payload[mapperMappingsByPairStorageKey] = mapperState.mappingsByPair
    }

    suppressNextMappingsRefresh = true
    chrome.storage.local.set(payload)
}

function persistMappingsFromUi() {
    let mappings = collectMappingsFromUi()
    persistMappingsToStorage(mappings, true)
}

function clearMapperMappings(showStatus = true, options = {}) {
    $('#bsd-map-cards').html('')
    mapperState.mappings = []
    let clearPairStore = options && options.clearPairStore === true
    let payload = { [mapperStorageKey]: [] }
    if (clearPairStore) {
        let pairKey = getActiveSynergyCanvasPairKey()
        if (pairKey) {
            let byPair = ensurePlainObject(mapperState.mappingsByPair)
            delete byPair[pairKey]
            mapperState.mappingsByPair = byPair
            payload[mapperMappingsByPairStorageKey] = mapperState.mappingsByPair
        }
    }
    suppressNextMappingsRefresh = true
    chrome.storage.local.set(payload)
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
        synergy_header_id: String(selectedSynAltOption.attr('data-header-id') || ''),
        assignment_id: getCardCanvasAssignment(card),
        rubric_id: row.find('.bsd-canvas-alt-select').val()
    }
}

function selectHasOptionValue(selectEl, value) {
    let wanted = String(value || '')
    if (!wanted) {
        return false
    }
    return selectEl.find('option').filter((_, optionEl) => String($(optionEl).val()) === wanted).length > 0
}

function getTrackedManualAlignmentKeysForRow(row, mapping = null) {
    let trackedRowKey = String(row.attr('data-manual-row-key') || '')
    let trackedLegacyRowKey = String(row.attr('data-manual-legacy-key') || '')
    if (trackedRowKey || trackedLegacyRowKey) {
        return {
            rowKey: trackedRowKey,
            legacyRowKey: trackedLegacyRowKey
        }
    }

    let currentMapping = mapping || getMappingFromRow(row)
    return {
        rowKey: getManualRowAlignmentKey(
            currentMapping.synergy_assignment,
            '',
            currentMapping.synergy_alt,
            currentMapping.synergy_header_id
        ),
        legacyRowKey: getLegacyManualRowAlignmentKey(currentMapping.synergy_assignment, currentMapping.col_index)
    }
}

function updateTrackedManualAlignmentKeysForRow(row, mapping = null) {
    let currentMapping = mapping || getMappingFromRow(row)
    let rowKey = getManualRowAlignmentKey(
        currentMapping.synergy_assignment,
        '',
        currentMapping.synergy_alt,
        currentMapping.synergy_header_id
    )
    let legacyRowKey = getLegacyManualRowAlignmentKey(currentMapping.synergy_assignment, currentMapping.col_index)

    if (rowKey) {
        row.attr('data-manual-row-key', rowKey)
    } else {
        row.removeAttr('data-manual-row-key')
    }

    if (legacyRowKey) {
        row.attr('data-manual-legacy-key', legacyRowKey)
    } else {
        row.removeAttr('data-manual-legacy-key')
    }

    return {
        rowKey,
        legacyRowKey
    }
}

function clearTrackedManualAlignmentKeysForRow(row) {
    row.removeAttr('data-manual-row-key')
    row.removeAttr('data-manual-legacy-key')
}

function getManualAlignmentDataForCurrentPair() {
    return getStoredManualAlignmentsForPairKey(getActiveSynergyCanvasPairKey())
}

function persistManualAlignmentDataForCurrentPair(manualSet) {
    let pairKey = getActiveSynergyCanvasPairKey()
    if (!pairKey) {
        return
    }
    setStoredManualAlignmentsForPairKey(pairKey, manualSet)
    chrome.storage.local.set({
        [manualAlignmentsByPairStorageKey]: mapperState.manualAlignmentsByPair
    })
}

function rememberManualAssignmentAlignment(card) {
    let synergyAssignment = getCardSynergyAssignment(card)
    let synergyKey = getManualSynergyAssignmentKey(synergyAssignment)
    if (!synergyKey) {
        return
    }

    let assignmentId = String(getCardCanvasAssignment(card) || '')
    let manualSet = getManualAlignmentDataForCurrentPair()
    if (assignmentId) {
        manualSet.assignmentBySynergy[synergyKey] = assignmentId
    } else {
        delete manualSet.assignmentBySynergy[synergyKey]
    }

    // When assignment changes, prune stale row overrides tied to other assignment IDs.
    Object.keys(manualSet.rowBySynergyCol).forEach((rowKey) => {
        if (!rowKey.startsWith(`${synergyKey}::`)) {
            return
        }
        let rowOverride = manualSet.rowBySynergyCol[rowKey]
        let rowAssignmentId = String(rowOverride && rowOverride.assignment_id ? rowOverride.assignment_id : '')
        if (!assignmentId || rowAssignmentId !== assignmentId) {
            delete manualSet.rowBySynergyCol[rowKey]
        }
    })

    persistManualAlignmentDataForCurrentPair(manualSet)
}

function rememberManualRowAlignment(row) {
    let mapping = getMappingFromRow(row)
    let synergyKey = getManualSynergyAssignmentKey(mapping.synergy_assignment)
    let colIndex = String(mapping.col_index || '')
    let previousKeys = getTrackedManualAlignmentKeysForRow(row, mapping)
    let rowKey = getManualRowAlignmentKey(mapping.synergy_assignment, '', mapping.synergy_alt, mapping.synergy_header_id)
    let legacyRowKey = getLegacyManualRowAlignmentKey(mapping.synergy_assignment, colIndex)
    if (!synergyKey) {
        return
    }

    let manualSet = getManualAlignmentDataForCurrentPair()
    let assignmentId = String(mapping.assignment_id || '')
    let rubricId = String(mapping.rubric_id || '')

    ;[previousKeys.rowKey, previousKeys.legacyRowKey, legacyRowKey]
        .filter(Boolean)
        .forEach((key) => {
            delete manualSet.rowBySynergyCol[key]
        })

    if (assignmentId) {
        manualSet.assignmentBySynergy[synergyKey] = assignmentId
    }

    if (assignmentId && rubricId && rowKey) {
        manualSet.rowBySynergyCol[rowKey] = {
            col_index: colIndex,
            synergy_assignment: String(mapping.synergy_assignment || ''),
            synergy_alt: String(mapping.synergy_alt || ''),
            synergy_header_id: String(mapping.synergy_header_id || ''),
            assignment_id: assignmentId,
            rubric_id: rubricId
        }
    }

    persistManualAlignmentDataForCurrentPair(manualSet)
    updateTrackedManualAlignmentKeysForRow(row, mapping)
}

function forgetManualRowAlignment(row) {
    let mapping = getMappingFromRow(row)
    let previousKeys = getTrackedManualAlignmentKeysForRow(row, mapping)
    let currentRowKey = getManualRowAlignmentKey(
        mapping.synergy_assignment,
        '',
        mapping.synergy_alt,
        mapping.synergy_header_id
    )
    let currentLegacyRowKey = getLegacyManualRowAlignmentKey(mapping.synergy_assignment, mapping.col_index)
    let keysToDelete = [previousKeys.rowKey, previousKeys.legacyRowKey, currentRowKey, currentLegacyRowKey]
        .filter(Boolean)
    if (keysToDelete.length === 0) {
        return
    }

    let manualSet = getManualAlignmentDataForCurrentPair()
    keysToDelete.forEach((key) => {
        delete manualSet.rowBySynergyCol[key]
    })
    persistManualAlignmentDataForCurrentPair(manualSet)
    clearTrackedManualAlignmentKeysForRow(row)
}

function forgetManualAssignmentAlignment(card) {
    let synergyKey = getManualSynergyAssignmentKey(getCardSynergyAssignment(card))
    if (!synergyKey) {
        return
    }

    let manualSet = getManualAlignmentDataForCurrentPair()
    delete manualSet.assignmentBySynergy[synergyKey]
    Object.keys(manualSet.rowBySynergyCol).forEach((rowKey) => {
        if (rowKey.startsWith(`${synergyKey}::`)) {
            delete manualSet.rowBySynergyCol[rowKey]
        }
    })
    persistManualAlignmentDataForCurrentPair(manualSet)
}

function applyStoredManualAlignmentsForCurrentPair(shouldPersistMappings = false) {
    let pairKey = getActiveSynergyCanvasPairKey()
    if (!pairKey) {
        return { assignmentCount: 0, rowCount: 0 }
    }

    let manualSet = getStoredManualAlignmentsForPairKey(pairKey)
    let assignmentOverrides = ensurePlainObject(manualSet.assignmentBySynergy)
    let rowOverrides = ensurePlainObject(manualSet.rowBySynergyCol)
    if (Object.keys(assignmentOverrides).length === 0 && Object.keys(rowOverrides).length === 0) {
        return { assignmentCount: 0, rowCount: 0 }
    }

    let assignmentCount = 0
    let rowCount = 0

    getMapperCards().each((_, cardEl) => {
        let card = $(cardEl)
        let synergyKey = getManualSynergyAssignmentKey(getCardSynergyAssignment(card))
        if (!synergyKey) {
            return
        }

        let canvasAssignSelect = card.find('.bsd-card-canvas-assign-select')
        let wantedAssignmentId = String(assignmentOverrides[synergyKey] || '')

        let rowOverrideList = Object.values(rowOverrides).filter((rowOverride) => {
            let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
            let overrideKey = getManualSynergyAssignmentKey(override.synergy_assignment)
            return overrideKey === synergyKey
        })
        let resolvedRowOverrideList = rowOverrideList
            .map((rowOverride) => {
                let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
                let resolvedOverride = reconcileStoredMappingToVisibleColumns(override)
                let colIndex = String(resolvedOverride.col_index || '')
                let rubricId = String(override.rubric_id || resolvedOverride.rubric_id || '')
                let assignmentId = String(override.assignment_id || resolvedOverride.assignment_id || '')
                if (!colIndex || !rubricId) {
                    return null
                }
                return {
                    ...override,
                    ...resolvedOverride,
                    col_index: colIndex,
                    rubric_id: rubricId,
                    assignment_id: assignmentId
                }
            })
            .filter(Boolean)

        if (wantedAssignmentId && resolvedRowOverrideList.length > 0) {
            let hasMatchingOverride = resolvedRowOverrideList.some((rowOverride) => {
                let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
                return String(override.assignment_id || '') === wantedAssignmentId
            })
            if (!hasMatchingOverride) {
                wantedAssignmentId = ''
            }
        }
        if (!wantedAssignmentId && resolvedRowOverrideList.length > 0) {
            let counts = {}
            resolvedRowOverrideList.forEach((rowOverride) => {
                let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
                let assignmentId = String(override.assignment_id || '')
                if (!assignmentId) {
                    return
                }
                counts[assignmentId] = Number(counts[assignmentId] || 0) + 1
            })
            wantedAssignmentId = Object.keys(counts).sort((a, b) => Number(counts[b]) - Number(counts[a]))[0] || ''
        }
        if (wantedAssignmentId) {
            resolvedRowOverrideList = resolvedRowOverrideList.filter((rowOverride) => {
                let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
                return String(override.assignment_id || '') === wantedAssignmentId
            })
        }
        if (
            wantedAssignmentId &&
            selectHasOptionValue(canvasAssignSelect, wantedAssignmentId) &&
            String(canvasAssignSelect.val() || '') !== wantedAssignmentId
        ) {
            canvasAssignSelect.val(wantedAssignmentId)
            updateCanvasUpdatedCell(card, wantedAssignmentId)
            refreshCardRowCanvasAltOptions(card)
            assignmentCount += 1
        }

        resolvedRowOverrideList.forEach((rowOverride) => {
            let override = rowOverride && typeof rowOverride === 'object' ? rowOverride : {}
            let colIndex = String(override.col_index || '')
            let rubricId = String(override.rubric_id || '')
            if (!colIndex || !rubricId) {
                return
            }

            let row = getRowsForCard(card).filter((_, rowEl) => {
                return String($(rowEl).find('.bsd-syn-alt-select').val() || '') === colIndex
            }).first()
            if (row.length === 0) {
                createMapperCardRow(card, { col_index: colIndex })
                row = getRowsForCard(card).filter((_, rowEl) => {
                    return String($(rowEl).find('.bsd-syn-alt-select').val() || '') === colIndex
                }).first()
            }
            if (row.length === 0) {
                return
            }

            let rowCanvasAltSelect = row.find('.bsd-canvas-alt-select')
            if (
                selectHasOptionValue(rowCanvasAltSelect, rubricId) &&
                String(rowCanvasAltSelect.val() || '') !== rubricId
            ) {
                rowCanvasAltSelect.val(rubricId)
                rowCount += 1
            }
        })

        updateCardPasteStates(card)
    })

    if (shouldPersistMappings) {
        persistMappingsFromUi()
    }
    return { assignmentCount, rowCount }
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
    let container = input.closest('.bsd-row-field, .bsd-meta-field, .bsd-card-assignment-field')
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

async function pasteSingleRow(row, resolvedTab = null) {
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
        let tab = resolvedTab
        if (!tab) {
            tab = await resolveSynergyTab()
        }
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
        showPasteAllToast('No mapped rows to paste.', true)
        return
    }

    let tab = await resolveSynergyTab()
    if (!tab) {
        setMapperStatus('Open a Synergy gradebook tab before pasting.', true)
        showPasteAllToast('Open Synergy gradebook to paste.', true)
        return
    }
    mapperState.activeTabId = tab.id
    mapperState.activeTabUrl = tab.url || ''

    setMapperStatus(`Pasting ${rows.length} mapping row(s)...`)
    setPasteAllActivity(true, `Pasting ${rows.length} rows...`)
    let successCount = 0
    let errorCount = 0

    try {
        for (let i = 0; i < rows.length; i++) {
            let row = $(rows[i])
            await pasteSingleRow(row, tab)
            let rowStatus = String(row.find('.bsd-row-status').text() || '')
            if (rowStatus.startsWith('Done:')) {
                successCount += 1
            } else if (rowStatus.startsWith('Error:')) {
                errorCount += 1
            }
        }
    } catch (e) {
        setMapperStatus(`Paste run failed: ${e.message}`, true)
        showPasteAllToast('Paste failed. Check row statuses.', true, 3000)
        return
    } finally {
        setPasteAllActivity(false)
    }

    if (errorCount > 0) {
        setMapperStatus(`Paste run complete: ${successCount}/${rows.length} succeeded, ${errorCount} failed.`, true)
        showPasteAllToast(`Paste complete: ${successCount}/${rows.length} succeeded`, true, 2800)
    } else {
        setMapperStatus(`Paste run complete for ${rows.length} mapping row(s).`)
        showPasteAllToast(`Paste successful: ${successCount}/${rows.length} rows`, false, 2200)
    }
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
        syncMappingsFromCurrentPair()

        renderMappingsFromState()
        autoMatchAllMappings(false, false, false)
        let appliedManual = applyStoredManualAlignmentsForCurrentPair(false)
        if ((appliedManual.assignmentCount + appliedManual.rowCount) > 0) {
            persistMappingsFromUi()
        }

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

    setMapperStatus('Refreshing Synergy context and checking Canvas updates...')
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

    await fetchCanvasScoresAndAutoMatch()
}

async function fetchCanvasScoresAndAutoMatch() {
    if (canvasFetchInFlight) {
        setMapperStatus('Canvas fetch is already in progress.', true)
        return
    }
    if (!hasSelectedCanvasCourse()) {
        setMapperStatus('Select a Canvas course first.', true)
        return
    }

    suppressLocalRefreshEvents = true
    try {
        clearMapperMappings(false, { clearPairStore: true })
        let fetchResult = await fetchAllCanvasDataForCourse(mapperState.selectedCanvasCourseId, {
            manageLoading: true,
            forceAssignmentsRefresh: false
        })

        if (!fetchResult) {
            return
        }

        await refreshMapperPanel(false)
        autoMatchAllMappings(true, true, true)
        let appliedManual = applyStoredManualAlignmentsForCurrentPair(true)
        if ((appliedManual.assignmentCount + appliedManual.rowCount) > 0) {
            setMapperStatus(
                `Auto-match complete. Re-applied ${appliedManual.assignmentCount} manual assignment and ${appliedManual.rowCount} manual target alignment(s).`
            )
        }
    } finally {
        suppressLocalRefreshEvents = false
    }
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

    $('#bsd-canvas-course-select').on('change', async () => {
        await onCanvasCourseSelectionChanged(false)
    })

    $('#bsd-refresh-data').on('click', async () => {
        if (refreshActionInFlight) {
            return
        }

        let hasFetched = hasFetchedSubmissionsReady()
        setRefreshActivity(true, hasFetched ? 'Refreshing...' : 'Fetching...')
        try {
            if (hasFetched) {
                await runRefreshWorkflow()
                return
            }
            await fetchCanvasScoresAndAutoMatch()
        } finally {
            setRefreshActivity(false)
        }
    })

    $('#bsd-sort-method').on('change', () => {
        persistSortMethodFromUi()
    })

    $('#bsd-apply-sort').on('click', () => {
        persistSortMethodFromUi()
        sortMapperCards(mapperState.sortMethod, true)
    })

    $('#bsd-toggle-assignment-helper').on('click', function () {
        if ($(this).prop('disabled')) {
            return
        }
        mapperState.assignmentHelperExpanded = !mapperState.assignmentHelperExpanded
        updateCopyCanvasAssignmentHelperUi()
    })

    $('#bsd-copy-canvas-assignment').on('change', async () => {
        let select = $('#bsd-copy-canvas-assignment')
        let assignmentId = String(select.val() || '')
        if (!assignmentId) {
            return
        }

        mapperState.copiedCanvasAssignmentId = assignmentId
        renderCopyCanvasAssignmentDetails()

        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), assignmentId)
        let assignmentLabel = normalizeHeaderText(assignment && assignment.name ? assignment.name : '')
        if (!assignmentLabel) {
            assignmentLabel = getSelectedCanvasAssignmentLabel(select)
        }

        let copied = await copyTextToClipboard(assignmentLabel)
        if (copied) {
            showClipboardCopyTooltip(select, 'Copied assignment title')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }

        select.val('')
    })

    $('#bsd-copy-canvas-assignment-copy-due-date').on('click', async function () {
        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), mapperState.copiedCanvasAssignmentId)
        let shortDueDate = getCanvasShortDate(assignment && assignment.due_at)
        if (!shortDueDate) {
            return
        }

        let copied = await copyTextToClipboard(shortDueDate)
        if (copied) {
            showClipboardCopyTooltip(this, 'Copied due date')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }
    })

    $('#bsd-copy-canvas-assignment-copy-name').on('click', async function () {
        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), mapperState.copiedCanvasAssignmentId)
        let assignmentLabel = getCanvasAssignmentLinkLabel(assignment)
        if (!assignmentLabel) {
            return
        }

        let copied = await copyTextToClipboard(assignmentLabel)
        if (copied) {
            showClipboardCopyTooltip(this, 'Copied assign name')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }
    })

    $('#bsd-copy-canvas-assignment-copy-assign-date').on('click', async function () {
        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), mapperState.copiedCanvasAssignmentId)
        let shortAssignDate = getCanvasShortDate(assignment && assignment.created_at)
        if (!shortAssignDate) {
            return
        }

        let copied = await copyTextToClipboard(shortAssignDate)
        if (copied) {
            showClipboardCopyTooltip(this, 'Copied assign date')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }
    })

    $('#bsd-copy-canvas-assignment-copy-url').on('click', async function () {
        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), mapperState.copiedCanvasAssignmentId)
        let assignmentUrl = getCanvasAssignmentUrl(assignment)
        if (!assignmentUrl) {
            return
        }

        let copied = await copyTextToClipboard(assignmentUrl)
        if (copied) {
            showClipboardCopyTooltip(this, 'Copied assignment URL')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }
    })

    $('#bsd-copy-canvas-assignment-copy-formatted-link').on('click', async function () {
        let assignment = getAssignmentById(getCachedAssignmentsForSelectedCourse(), mapperState.copiedCanvasAssignmentId)
        let linkParts = getCanvasAssignmentFormattedLinkParts(assignment)
        if (!linkParts) {
            return
        }

        let copied = await copyHtmlToClipboard(linkParts.html, linkParts.text)
        if (copied) {
            showClipboardCopyTooltip(this, 'Copied formatted link')
        } else if (!clipboardCopyWarningShown) {
            setMapperStatus('Could not copy assignment text to clipboard. Check browser clipboard permissions.', true)
            clipboardCopyWarningShown = true
        }
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
    mapperState.canvasIncludeConcludedCourses = false
    mapperState.canvasCourseFilter = ''
    setRefreshActivity(false)
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
            let mappingChanged = Boolean(
                changes[mapperStorageKey] ||
                changes[mapperMappingsByPairStorageKey]
            )
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
