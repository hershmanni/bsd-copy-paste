/*
    Compare live Canvas submissions against cached submissionsByAssignment data.

    Run this from the extension sidepanel DevTools console so chrome.storage.local is available.

    Usage:
    1. Open the extension sidepanel.
    2. Open DevTools for the sidepanel.
    3. Set courseId and assignmentId below.
    4. Paste this file into the console.
    5. Review console.table output and window.__canvasSubmissionCompareRows.
*/

(async () => {
    const courseId = ''
    const assignmentId = ''
    const baseUrlOverride = ''

    if (!chrome || !chrome.storage || !chrome.storage.local) {
        throw new Error('Run this from the extension sidepanel DevTools console.')
    }

    if (!String(assignmentId || '').trim()) {
        throw new Error('Set assignmentId before running this helper.')
    }

    function storageGet(keys) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message))
                    return
                }
                resolve(result || {})
            })
        })
    }

    function ensurePlainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    async function fetchJson(url) {
        let response = await fetch(url, { credentials: 'include' })
        if (!response.ok) {
            throw new Error(`Fetch failed: ${response.status} ${url}`)
        }
        return response.json()
    }

    async function fetchAllPages(buildUrl) {
        let all = []
        for (let page = 1; ; page += 1) {
            let data = await fetchJson(buildUrl(page))
            if (!Array.isArray(data) || data.length === 0) {
                break
            }
            all.push(...data)
            if (data.length < 100) {
                break
            }
        }
        return all
    }

    function summarizeRubric(rubricAssessment) {
        if (!rubricAssessment || typeof rubricAssessment !== 'object') {
            return ''
        }

        return Object.keys(rubricAssessment)
            .sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }))
            .map((criterionId) => {
                let criterion = rubricAssessment[criterionId]
                let points = criterion && Object.prototype.hasOwnProperty.call(criterion, 'points')
                    ? criterion.points
                    : ''
                return `${criterionId}:${points}`
            })
            .join(' | ')
    }

    function normalizeTimestamp(value) {
        return value ? String(value) : ''
    }

    function normalizeScalar(value) {
        if (value == null || value === '') {
            return ''
        }
        return String(value)
    }

    function compareTimestamp(liveValue, cachedValue) {
        let live = normalizeTimestamp(liveValue)
        let cached = normalizeTimestamp(cachedValue)
        if (!live && !cached) {
            return 'missing_both'
        }
        if (live === cached) {
            return 'match'
        }
        let liveMs = live ? Date.parse(live) : 0
        let cachedMs = cached ? Date.parse(cached) : 0
        if (live && !cached) {
            return 'live_only'
        }
        if (!live && cached) {
            return 'cache_only'
        }
        if (!Number.isNaN(liveMs) && !Number.isNaN(cachedMs)) {
            if (liveMs > cachedMs) {
                return 'live_newer'
            }
            if (cachedMs > liveMs) {
                return 'cache_newer'
            }
        }
        return 'different'
    }

    function compareScalar(liveValue, cachedValue) {
        let live = normalizeScalar(liveValue)
        let cached = normalizeScalar(cachedValue)
        return live === cached
    }

    let local = await storageGet([
        'canvasBaseUrl',
        'canvasCourseId',
        'submissionsByAssignment',
        'submissionsByAssignmentByCourse',
        'canvasAssignmentsByCourse'
    ])

    let resolvedCourseId = String(courseId || local.canvasCourseId || '').trim()
    let resolvedAssignmentId = String(assignmentId || '').trim()
    let resolvedBaseUrl = String(baseUrlOverride || local.canvasBaseUrl || '').trim()

    if (!resolvedCourseId) {
        throw new Error('Set courseId, or load the sidepanel with a selected Canvas course first.')
    }
    if (!resolvedBaseUrl) {
        throw new Error('Canvas base URL not found in storage. Load Canvas data in the sidepanel first, or set baseUrlOverride.')
    }

    let submissionsByCourse = ensurePlainObject(local.submissionsByAssignmentByCourse)
    let courseSubmissions = ensurePlainObject(submissionsByCourse[resolvedCourseId])
    let topLevelSubmissions = ensurePlainObject(local.submissionsByAssignment)
    let cachedSubmissions = Array.isArray(courseSubmissions[resolvedAssignmentId])
        ? courseSubmissions[resolvedAssignmentId]
        : (Array.isArray(topLevelSubmissions[resolvedAssignmentId]) ? topLevelSubmissions[resolvedAssignmentId] : [])

    let assignmentsByCourse = ensurePlainObject(local.canvasAssignmentsByCourse)
    let assignments = Array.isArray(assignmentsByCourse[resolvedCourseId]) ? assignmentsByCourse[resolvedCourseId] : []
    let cachedAssignment = assignments.find((assignment) => String(assignment && assignment.id ? assignment.id : '') === resolvedAssignmentId) || null

    let [liveSubmissions, sections, liveAssignment] = await Promise.all([
        fetchAllPages((page) => {
            let url = new URL(
                `/api/v1/courses/${resolvedCourseId}/assignments/${resolvedAssignmentId}/submissions`,
                resolvedBaseUrl
            )
            url.searchParams.set('per_page', '100')
            url.searchParams.set('page', String(page))
            url.searchParams.append('include[]', 'rubric_assessment')
            return url.toString()
        }),
        fetchAllPages((page) => {
            let url = new URL(`/api/v1/courses/${resolvedCourseId}/sections`, resolvedBaseUrl)
            url.searchParams.set('per_page', '100')
            url.searchParams.set('page', String(page))
            url.searchParams.append('include[]', 'students')
            return url.toString()
        }),
        fetchJson(`${resolvedBaseUrl}/api/v1/courses/${resolvedCourseId}/assignments/${resolvedAssignmentId}`)
    ])

    let studentMap = new Map()
    sections.forEach((section) => {
        ;(section.students || []).forEach((student) => {
            let key = String(student && student.id ? student.id : '')
            if (key && !studentMap.has(key)) {
                studentMap.set(key, student)
            }
        })
    })

    let liveByCanvasId = new Map()
    liveSubmissions.forEach((submission) => {
        let key = String(submission && submission.user_id ? submission.user_id : '')
        if (key) {
            liveByCanvasId.set(key, submission)
        }
    })

    let cacheByCanvasId = new Map()
    cachedSubmissions.forEach((submission) => {
        let key = String(submission && submission.canvas_id ? submission.canvas_id : '')
        if (key) {
            cacheByCanvasId.set(key, submission)
        }
    })

    let allCanvasIds = Array.from(new Set([
        ...Array.from(liveByCanvasId.keys()),
        ...Array.from(cacheByCanvasId.keys())
    ]))

    let rows = allCanvasIds
        .map((canvasId) => {
            let live = liveByCanvasId.get(canvasId) || null
            let cached = cacheByCanvasId.get(canvasId) || null
            let student = studentMap.get(canvasId) || {}
            let liveRubric = summarizeRubric(live ? live.rubric_assessment : null)
            let cachedRubric = summarizeRubric(cached ? cached.rubric_assessment : null)
            let gradedAtStatus = compareTimestamp(
                live ? live.graded_at : '',
                cached ? cached.graded_at : ''
            )
            let enteredScoreMatch = compareScalar(
                live && Object.prototype.hasOwnProperty.call(live, 'entered_score') ? live.entered_score : '',
                cached && Object.prototype.hasOwnProperty.call(cached, 'entered_score') ? cached.entered_score : ''
            )
            let excusedMatch = compareScalar(live ? Boolean(live.excused) : '', cached ? Boolean(cached.excused) : '')
            let lateMatch = compareScalar(live ? Boolean(live.late) : '', cached ? Boolean(cached.late) : '')
            let missingMatch = compareScalar(live ? Boolean(live.missing) : '', cached ? Boolean(cached.missing) : '')
            let rubricMatch = liveRubric === cachedRubric
            let gradedAtMs = live && live.graded_at ? Date.parse(live.graded_at) : 0
            let submittedAtMs = live && live.submitted_at ? Date.parse(live.submitted_at) : 0
            let anyDifference = (
                gradedAtStatus !== 'match' ||
                !enteredScoreMatch ||
                !excusedMatch ||
                !lateMatch ||
                !missingMatch ||
                !rubricMatch ||
                !live ||
                !cached
            )

            return {
                canvas_id: canvasId,
                student: student.sortable_name || student.name || (cached && cached.short_name ? cached.short_name : ''),
                live_present: Boolean(live),
                cached_present: Boolean(cached),
                graded_at_status: gradedAtStatus,
                live_graded_at: live && live.graded_at ? live.graded_at : '',
                cached_graded_at: cached && cached.graded_at ? cached.graded_at : '',
                live_submitted_at: live && live.submitted_at ? live.submitted_at : '',
                live_posted_at: live && live.posted_at ? live.posted_at : '',
                live_entered_score: live && Object.prototype.hasOwnProperty.call(live, 'entered_score') ? live.entered_score : '',
                cached_entered_score: cached && Object.prototype.hasOwnProperty.call(cached, 'entered_score') ? cached.entered_score : '',
                entered_score_match: enteredScoreMatch,
                excused_match: excusedMatch,
                late_match: lateMatch,
                missing_match: missingMatch,
                rubric_match: rubricMatch,
                live_grade_matches_current_submission: live ? live.grade_matches_current_submission : '',
                live_submission_newer_than_grade: Boolean(gradedAtMs && submittedAtMs && submittedAtMs > gradedAtMs),
                any_difference: anyDifference,
                live_rubric: liveRubric,
                cached_rubric: cachedRubric
            }
        })
        .sort((left, right) => {
            if (left.any_difference !== right.any_difference) {
                return left.any_difference ? -1 : 1
            }
            return String(left.student || '').localeCompare(String(right.student || ''))
        })

    let mismatchRows = rows.filter((row) => row.any_difference)
    let summary = {
        courseId: resolvedCourseId,
        assignmentId: resolvedAssignmentId,
        assignmentName:
            (liveAssignment && liveAssignment.name ? liveAssignment.name : '') ||
            (cachedAssignment && cachedAssignment.name ? cachedAssignment.name : ''),
        liveSubmissionCount: liveSubmissions.length,
        cachedSubmissionCount: cachedSubmissions.length,
        mismatchCount: mismatchRows.length,
        gradedAtMismatchCount: rows.filter((row) => row.graded_at_status !== 'match').length,
        enteredScoreMismatchCount: rows.filter((row) => !row.entered_score_match).length,
        rubricMismatchCount: rows.filter((row) => !row.rubric_match).length
    }

    window.__canvasSubmissionCompareRows = rows
    window.__canvasSubmissionCompareSummary = summary

    console.log(summary)
    console.table(rows)
    console.log('Rows saved to window.__canvasSubmissionCompareRows')
    console.log('Summary saved to window.__canvasSubmissionCompareSummary')
})()
