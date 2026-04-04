/*
    Canvas submissions review helper.

    Usage:
    1. Open a Canvas page while logged in.
    2. Set courseId and assignmentId below, or leave them blank to auto-detect from an assignment URL.
    3. Paste this file into the browser console.
    4. Review console.table output and window.__canvasSubmissionRows.
*/

(async () => {
    const courseId = ''
    const assignmentId = ''
    const base = window.location.origin

    function resolveCanvasIds() {
        let resolvedCourseId = String(courseId || '').trim()
        let resolvedAssignmentId = String(assignmentId || '').trim()

        if (!resolvedCourseId || !resolvedAssignmentId) {
            let match = String(window.location.pathname || '').match(/\/courses\/(\d+)\/assignments\/(\d+)/)
            if (match) {
                if (!resolvedCourseId) {
                    resolvedCourseId = String(match[1] || '')
                }
                if (!resolvedAssignmentId) {
                    resolvedAssignmentId = String(match[2] || '')
                }
            }
        }

        if (!resolvedCourseId || !resolvedAssignmentId) {
            throw new Error('Set courseId and assignmentId, or run this from a Canvas assignment page.')
        }

        return {
            courseId: resolvedCourseId,
            assignmentId: resolvedAssignmentId
        }
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
            let url = buildUrl(page)
            let data = await fetchJson(url)
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

        return Object.entries(rubricAssessment)
            .map(([criterionId, value]) => {
                let points = value && Object.prototype.hasOwnProperty.call(value, 'points')
                    ? value.points
                    : ''
                return `${criterionId}:${points}`
            })
            .join(' | ')
    }

    let ids = resolveCanvasIds()
    let resolvedCourseId = ids.courseId
    let resolvedAssignmentId = ids.assignmentId

    let [submissions, sections, assignment] = await Promise.all([
        fetchAllPages((page) => {
            let url = new URL(
                `/api/v1/courses/${resolvedCourseId}/assignments/${resolvedAssignmentId}/submissions`,
                base
            )
            url.searchParams.set('per_page', '100')
            url.searchParams.set('page', String(page))
            url.searchParams.append('include[]', 'rubric_assessment')
            return url.toString()
        }),
        fetchAllPages((page) => {
            let url = new URL(`/api/v1/courses/${resolvedCourseId}/sections`, base)
            url.searchParams.set('per_page', '100')
            url.searchParams.set('page', String(page))
            url.searchParams.append('include[]', 'students')
            return url.toString()
        }),
        fetchJson(`${base}/api/v1/courses/${resolvedCourseId}/assignments/${resolvedAssignmentId}`)
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

    let rows = submissions
        .map((submission) => {
            let student = studentMap.get(String(submission && submission.user_id ? submission.user_id : '')) || {}
            let gradedAtMs = submission && submission.graded_at ? Date.parse(submission.graded_at) : 0
            let submittedAtMs = submission && submission.submitted_at ? Date.parse(submission.submitted_at) : 0

            return {
                user_id: submission && submission.user_id ? submission.user_id : '',
                student: student.sortable_name || student.name || '',
                workflow_state: submission && submission.workflow_state ? submission.workflow_state : '',
                attempt: submission && submission.attempt ? submission.attempt : '',
                submitted_at: submission && submission.submitted_at ? submission.submitted_at : '',
                graded_at: submission && submission.graded_at ? submission.graded_at : '',
                posted_at: submission && submission.posted_at ? submission.posted_at : '',
                entered_score: submission && Object.prototype.hasOwnProperty.call(submission, 'entered_score')
                    ? submission.entered_score
                    : '',
                score: submission && Object.prototype.hasOwnProperty.call(submission, 'score')
                    ? submission.score
                    : '',
                excused: Boolean(submission && submission.excused),
                late: Boolean(submission && submission.late),
                missing: Boolean(submission && submission.missing),
                grade_matches_current_submission: submission
                    ? submission.grade_matches_current_submission
                    : '',
                needs_review:
                    (submission && submission.grade_matches_current_submission === false) ||
                    Boolean(gradedAtMs && submittedAtMs && submittedAtMs > gradedAtMs),
                rubric: summarizeRubric(submission ? submission.rubric_assessment : null)
            }
        })
        .sort((left, right) => {
            let leftMs = left.graded_at ? Date.parse(left.graded_at) : 0
            let rightMs = right.graded_at ? Date.parse(right.graded_at) : 0
            if (rightMs !== leftMs) {
                return rightMs - leftMs
            }
            return String(left.student || '').localeCompare(String(right.student || ''))
        })

    let latestGradedAt = rows
        .map((row) => row.graded_at || '')
        .filter(Boolean)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null

    window.__canvasSubmissionRows = rows

    console.log({
        courseId: resolvedCourseId,
        assignmentId: resolvedAssignmentId,
        assignmentName: assignment && assignment.name ? assignment.name : '',
        submissionCount: rows.length,
        latestGradedAt: latestGradedAt,
        assignmentUpdatedAt: assignment && assignment.updated_at ? assignment.updated_at : null,
        fallbackLastUpdated:
            latestGradedAt ||
            (assignment && assignment.updated_at ? assignment.updated_at : null) ||
            (assignment && assignment.due_at ? assignment.due_at : null) ||
            (assignment && assignment.created_at ? assignment.created_at : null) ||
            null
    })
    console.table(rows)
    console.log('Rows saved to window.__canvasSubmissionRows')
})()
