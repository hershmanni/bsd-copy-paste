//const base_url = 'https://bsd.test.instructure.com/api/v1'

async function getBaseUrl() {
    let queryOptions = {currentWindow: true, active: true}
    let tabs = await chrome.tabs.query(queryOptions)
    let base = await tabs[0].url.match(".*\.instructure.com")[0]
    console.log(`base url: ${base}`)
    return base
}

async function getUrl() {
    let queryOptions = {currentWindow: true, active: true}
    let tabs = await chrome.tabs.query(queryOptions)
    let url = await tabs[0].url
    console.log(`current url: ${url}`)
    return url
}

function showLoader(show) {
    if (show) {
        // gif reload solution based on https://stackoverflow.com/questions/9186928/animating-gifs-on-a-web-page-any-way-to-restart-them/9202472#9202472
        
        let my_src = $('div#processing img').attr('src').match(/.*\.gif/)[0]
        let query_string = '?'+(new Date()).valueOf() // query_string forces gif re-load so animation starts from beginning :)
        let new_src = my_src+query_string 
        console.log(`Loading gif set to ${new_src}`)
        $('div#processing img').attr('src',new_src)
        $('div#processing').show()
    } else {
        $('div#processing').hide()
    }
}

function update_assign_select(assignments, assign_id_selected = 0) {
    console.log(`Updating assign_select with ${assignments.length} assignments.`)
    $('div#assign_select').html('Assign: <select></select>');
    assignments.forEach((assignment, index) => {
        console.log(`Appending assignment ${index}, ${assignment.id}, ${assignment.name}`)
        let name = assignment.name;
        try {
            if (name.length > 50) {
                name = name.slice(0,50)+'...'
            }
        } catch(e) {
            console.log('Assignment name.length errors with',e)
        }
        
        if (assign_id_selected == assignment.id) {
            $('div#assign_select select')
            .append($('<option></option>')
            .attr('value',assignment.id)
            .attr('selected', true)
            .html(name))
        } else {
            $('div#assign_select select')
            .append($('<option></option>')
            .attr('value',assignment.id)
            .html(name))
        }
    })

    $('#assign_select select').change(() => {
        process_assign_change(course_id, assignments)
    });
}

/* replace synergy_ids in scores with dummy Id's for testing. */
const use_fake_synergy_ids = (scores) => {
    for (i = 0; i < Math.min(synFakeIds.length, scores.length); i++) {
        scores[i].sis_number = synFakeIds[i]
    }
    return(scores)
}

function getAssignmentById(assignments, assign_id) {
    if (assignments == []) {
        return(null)
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
    return(my_assign)
}

async function send_to_background(data, my_type = 'assignments') {
    let options = ['assignments', 'submissions']
    if (!options.includes(my_type)) {
        console.log(`inappropriate object type cannot send to background`)
        return null
    }

    let my_message = {
        from: 'popup.js',
        to: 'background.js',
        title: `sending_${my_type}`,
        body: `This message has ${data.length} ${my_type}`,
        attachment: data
    }

    try {
        await chrome.runtime.sendMessage(my_message)
    } catch (e) {
        console.log('Send to background failed with ' + e)
    }
}

async function getAssignments(course_id) {
    let page_n = 50;
    let page = 1;
    let data_length = page_n;
    assignments = [];
    showLoader(true)
    while (data_length == page_n) {
        let url = `${base_url}/api/v1/courses/${course_id}/assignments?order_by=due_at&page=${page}&per_page=${page_n}`
        console.log(`fetch assignments with: ${url}`)
        let res = await fetch(url);
        let data = await JSON.parse(await res.text());
        // console.log(`data length: ${data.length}`)
        data_length = data.length;
        if (data_length > 0) {
            
            // console.log(data);
            data.forEach((e) => {
                
                 let assignment = {
                    'id': e.id,
                    'course_id': course_id,
                    'name': e.name,
                    'use_rubric_for_grading': e.use_rubric_for_grading,
                    'points_possible': e.points_possible,
                    'rubric': e.rubric,
                    'due_at': e.due_at 
                }
                
                // only include assignments that have defined rubrics.
                if ((assignment.use_rubric_for_grading | assignment.rubric != undefined) & e.published) {
                    assignments.push(assignment)
                } else {
                    console.log(`Skipping ${assignment.name} because it does not use a rubric.`)
                    // console.log(e)
                }
            })
        } else {
            console.log(`Page ${page_n} contained no data.`)
        }
        page++;
    }

    // Remove Overall Outcomes from App (comment both lines below)
    // let outcome_assignment = await getOutcomeAssignment(course_id)
    // assignments.push(outcome_assignment)

    assignments = assignments.reverse() // most recent first.
    console.log(`Assignments found: ${assignments.length}`)
    showLoader(false)
    return(assignments)  
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

const getSynergyId = (students, canvas_id) => {
    students.forEach((e) => {
        if (e.canvas_id == canvas_id) {
            return e.synergy_id
        }
    })

    console.log(`No Synergy Match for Canvas ID ${canvas_id}`)
}

const add_synergy_id = (submissions, students) => {
    console.log(`Adding student_info to submissions`, submissions)
    console.log('students',students)
    matched_submissions = []
    matched_submission_ids = []
    submissions.forEach((s) => {
        // console.log('Adding syn_id for submission',s)
        let match = false
        students.forEach((t) => {
            if (s.canvas_id == t.canvas_id) {
                match = true
                s.synergy_id = t.synergy_id
                s.short_name = t.short_name
                s.sortable_name = t.sortable_name
                s.period = t.period

                // add submission to matched_submissions
                if (!matched_submission_ids.includes(s.synergy_id)) {
                    matched_submissions.push(s)
                    matched_submission_ids.push(s.synergy_id)
                } else {
                    console.log('duplicate student, not adding additional submission for student:',t)
                }
            }
        })
        if (!match) {
            console.log('No match for canvas_id',s.canvas_id,'submission',s)
        }
    })
    return(matched_submissions)
}

async function getSubmissions(course_id, assignments, assign_id) {
    showLoader(true)
    console.log(`Fetching scores w/ course (${course_id}), assign (${assign_id})`)
    let students = await getStudents(course_id)
    let page_n = 50
    let page = 1
    let data_length = page_n
    let submissions = []

    /* Why see multiple submissions...? */
    // let canvas_ids = []
    let assignment = getAssignmentById(assignments, assign_id)

    if (assign_id == 'outcomes') {
        submissions = await getOutcomes(course_id)
    } else {
        while (data_length == page_n) {
            let url = `${base_url}/api/v1/courses/${course_id}/assignments/${assign_id}/submissions?include[]=rubric_assessment&page=${page}&per_page=${page_n}`
            console.log(`Fetching ${url}`)
            let res = await fetch(url)
            let text = await res.text()
            let data = await JSON.parse(text)
            
            // console.log(data)
            data_length = data.length
            data.forEach((s) => {
                let submission = {}
                // console.log(`s: ${JSON.stringify(s)}`)
                // console.log(`s.ra: ${JSON.stringify(s.rubric_assessment)}`)

                // s is a score... s.rubric_assessment: object {_id, }
                try {
                    if ('rubric_assessment' in s) {
                        submission = {
                            'course_id': course_id,
                            'canvas_id': s.user_id,
                            'assign_id': s.assignment_id,
                            'assign_name': assignment.name,
                            'entered_score': s.entered_score,
                            'rubric_assessment': s.rubric_assessment,
                            'excused': s.excused,
                            'late' : s.late,
                            'missing': s.missing,
                            'grading_per': s.grading_period_id,
                            'full_object': s
                        }
                    } else {
                        submission = {
                            'course_id': course_id,
                            'canvas_id': s.user_id,
                            'synergy_id': s.synergy_id,
                            'assign_id': s.assignment_id,
                            'assign_name': assignment.name,
                            'entered_score': s.entered_score,
                            'score': '',
                            'excused': s.excused,
                            'late' : s.late,
                            'missing': s.missing,
                            'grading_per': s.grading_period_id,
                            'full_object': s
                        }
                    }
                } catch (e) {
                    console.log(`Error on score: ${JSON.stringify(s)}\nWith error: ${e}`)
                }
                if (Object.keys(submission).length > 0) {
                    submissions.push(submission)
                    
                    // if (canvas_ids.includes(submission.canvas_id)) {
                    //     console.log(`Already have a submission for c:${submission.canvas_id}... see submission:`,s)
                    //     submissions.forEach((s2) => {
                    //         if (s2.canvas_id == submission.canvas_id) {
                    //             console.log('Previously pushed submission from same user: ',s2)
                    //         }
                    //     })
                    // }
                    // canvas_ids.push(submission.canvas_id)
                    // // console.log('canvas_ids:',canvas_ids)

                }
            });
            page++;
        }
    }
    console.log(`Submissions found: ${submissions.length}`)
    submissions = add_synergy_id(submissions, students)
    console.log(`after adding synergy... we have ${submissions.length} submissions`)
    // send submissions to background.
    send_to_background(submissions, 'submissions')
    update_submissions_overview(submissions)
    showLoader(false)
    return(submissions)
}

// function getScoresFromSubmissionsByRubricId(submissions, rubric_id) {
//     // submissions objects.keys = {assign_id, canvas_id, excused, grading_per, late, rubric_assessment{}, synergy_id}
//     if (Object.keys(submissions).length == 0) {
//         console.log(`No submissions`)
//         return null
//     }
//     let scores = []
//     submissions.forEach((s) => {
//         let score = {}
//         try {
//             // when scores were marked excused there may not be a rubric attached...
//             if ('rubric_assessment' in s) {
//                 Object.keys(s.rubric_assessment).forEach((r) => {
//                     if (r == rubric_id) {
//                         let points = ''
//                         if (Object.keys(s.rubric_assessment[r]).includes('points')) {
//                             points = s.rubric_assessment[r].points
//                         } else {
//                             console.log(`Student ${s.canvas_id} / ${s.synergy_id} has no points for rubric_id ${r}`)
//                         }

//                         score = {
//                             'synergy_id': s.synergy_id,
//                             'rubric_id' : rubric_id,
//                             'score': points,
//                             'short_name': s.short_name, // wonder if we have access to short_name with submissions at this point...
//                             'excused': s.excused,
//                             'late' : s.late,
//                             'missing':s.missing,
//                             'course_id': s.course_id,
//                             'canvas_id': s.canvas_id,
//                             'assign_id': s.assign_id,
//                             'grading_per': s.grading_per,
//                         }
//                     }
//                 })
//             } else if (s.excused | s.missing) {
//                 score = {
//                     'synergy_id': s.synergy_id,
//                     'rubric_id' : rubric_id,
//                     'score': '',
//                     'short_name': s.short_name,
//                     'excused': s.excused,
//                     'late' : s.late,
//                     'missing': s.missing,
//                     'course_id': s.course_id,
//                     'canvas_id': s.canvas_id,
//                     'assign_id': s.assign_id,
//                     'grading_per': s.grading_per,
//                 }    
//             }

//         } catch (e) {
//             console.log(`Error on score extract ${e}`)
//             console.log(s)
//         }
//         if (Object.keys(score).length > 0) {
//             scores.push(score)
//         }
//     })

//     console.log('popup found scores',scores)
//     //console.log(`ALERT: calling use_fake_synergy_ids to swap sis_nums to match syntrn - fake sis_nums... remove in production!`)
//     //scores = use_fake_synergy_ids(scores)
//     return scores
// }

function countScoresFromSubmissionsByRubricId(submissions, rubric_id) {
    // submissions objects.keys = {assign_id, canvas_id, excused, grading_per, late, rubric_assessment{}, synergy_id}
    let rubric_scores = []
    let entered_scores = []
    let no_scores = []
    let missing = []
    let late = []
    let excused = []
    let skipped_entirely = []

    let summary = {
        'rubric_scores': rubric_scores,
        'entered_score': entered_scores,
        'no_scores': no_scores,
        'missing': missing,
        'late': late,
        'excused': excused,
        'skipped_entirely': skipped_entirely
    }

    if (Object.keys(submissions).length == 0) {
        console.log(`No submissions`)
        return summary
    }

    
    submissions.forEach((s) => {
        try {
            // when scores were marked excused there may not be a rubric attached...
            if ('rubric_assessment' in s) {
                Object.keys(s.rubric_assessment).forEach((r) => {
                    if (r == rubric_id) {
                        let points = ''
                        if (Object.keys(s.rubric_assessment[r]).includes('points')) {
                            points = s.rubric_assessment[r].points
                            rubric_scores.push(s)

                        } else {
                            console.log(`${s.short_name} has no points for rubric_id ${r}`)
                            no_scores.push(s)
                        }
                    }
                })
            } else if (s.excused) {
                excused.push(s)
            } else if (s.missing) {
                missing.push(s)
            } else {
                console.log(`Student ${s.short_name} not counted. See submission object`,s)
                skipped_entirely.push(s)
            }

            if (s.late) {
                late.push(s)
            }

            if (s.entered_score) {
                entered_scores.push(s)
            }
        } catch (e) {
            console.log(`Error on score count ${e}`)
            console.log(s)
        }
    })

    console.log(`popup found ${rubric_scores.length} scores and ${missing.length} missing and ${skipped_entirely.length} results that won't paste.`)
    //console.log(`ALERT: calling use_fake_synergy_ids to swap sis_nums to match syntrn - fake sis_nums... remove in production!`)
    //scores = use_fake_synergy_ids(scores)

    // sort all lists.

    my_list_vars = [rubric_scores, entered_scores, no_scores, missing, late, excused, skipped_entirely]

    my_list_vars.forEach((my_list) => {
        my_list.sort(function(a, b) {
            return a.sortable_name > b.sortable_name
        })
    })

    summary = {
        'rubric_scores': rubric_scores,
        'entered_score': entered_scores,
        'no_scores': no_scores,
        'missing': missing,
        'late': late,
        'excused': excused,
        'skipped_entirely': skipped_entirely
    }

    return summary
}

async function getStudents(course_id) {
    // let res = await fetch(`${base_url}/courses/${course_id}/students`)
    let res = await fetch(`${base_url}/api/v1/courses/${course_id}/sections?include[]=students`)

    let data = await JSON.parse(await res.text())
    let students = []
    // console.log(data[5]);
    data.forEach((s) => {

        let period = ''
        try {
            period = s.name.match(/Per\.\s(\d+)/)[1]
        } catch(e) {
            console.log(`Couldn't extract period from section ${s.name}`)
        }
        if (!period) {
            period = ''
        }

        console.log('section',s,'has period',period)
        
        try {
            s.students.forEach((e) => {

                // console.log(e.id, e.login_id, e.sortable_name, e.short_name)
                let student = {
                    'canvas_id': e.id,
                    'synergy_id': e.login_id,
                    'short_name': e.short_name,
                    'sortable_name': e.sortable_name,
                    'period': period
                }
                students.push(student)
            })
        } catch(e) {
            console.log('Error processing student list',e)
        }
    })
    console.log(`Students found: ${students.length}`, students)
    // console.log(students[3])
    return(students)
}

// adding support for Overall Outcomes
async function getOutcomes(course_id) {
    let url = `${base_url}/api/v1/courses/${course_id}/outcome_rollups`
    var outcomes = []
    var results = 1
    console.log(`Fetching ${url}`)
    var obj = await fetch(url)
    var data = JSON.parse(await obj.text())
    data.rollups.forEach((o) => {

        console.log('Outcome: ', o)
        try {
            if (o.scores.length > 0) {
    
                let rubrics = {}
    
                o.scores.forEach((s) => {
                    // let rubric = {}
                    console.log('Score: ', s)
                    if (!(s.links.outcome in Object.keys(rubrics))) {
                        rubrics[s.links.outcome] = {'points': s.score}
                    } else {
                        // already have outcome.
                    }
                    // rubrics.push(rubric)
                })

                console.log('Adding rubrics', rubrics)
    
                let outcome = {
                    'canvas_id': o.links.user,
                    'course_id': course_id,
                    'assign_id': 'outcomes',
                    'assign_name': 'Outcome Results from Learning Mastery',
                    'status': o.links.status,
                    'section':o.links.section,
                    'rubric_assessment': rubrics,
                    'scores': o.scores
                }
    
                if (outcome.status == 'active') {
                    outcomes.push(outcome)
                }
            }
        } catch(e) {
            console.log('Failed to add score with error: ',e)
        }
    })
    
    results = data.rollups.length
    console.log(`results of length: ${results}`)
    return outcomes
}

async function getOutcomeRubrics(course_id) {
    url =`${base_url}/api/v1/courses/${course_id}/rubrics?per_page=100&page=1`
    var obj = await fetch(url)
    var rubric_obj = {}
    var data = JSON.parse(await obj.text())
    console.log(`getOutcomeRubrics calling ${url}`)
    console.log('data', data)
    data.forEach((r, index) => {
        r.data.forEach((rubric) => {
            // rubrics[rubric.learning_outcome_id] = {
            rubric_obj[rubric.learning_outcome_id] = {
                'id': String(rubric.learning_outcome_id),
                'description': rubric.description,
                'long_description': rubric.long_description,
                'points': rubric.points
            }
            // rubrics.push(my_rubric)
        })
    })


    console.log('rubric_obj:',rubric_obj)
    
    // TODO get this sort to sort on description... so targets appear in alpha order...
    let descriptions = []
    Object.keys(rubric_obj).forEach((k) => {
        descriptions.push(rubric_obj[k].description)
    })

    descriptions = descriptions.sort() // descriptions are alpha sorted

    // create rubrics in order of our sorted descriptions
    let rubrics = []
    descriptions.forEach((d) => {
        Object.keys(rubric_obj).forEach((k) => {
            if (rubric_obj[k].description == d) {
                rubrics.push(rubric_obj[k])
            }
        })
    })


    // Object.keys(rubric_obj).sort().forEach((key) =>{
    //     rubrics.push(rubric_obj[key])
    // })

    console.log(`${Object.keys(rubrics).length} rubrics found!`)
    console.log(rubrics)
    return rubrics
}

async function getOutcomeAssignment(course_id) {
    let rubrics = await getOutcomeRubrics(course_id)
    let points_possible = 0
    Object.keys(rubrics).forEach((key) => {
        points_possible += rubrics[key].points
    })
    let assignment = {
        'course_id': course_id,
        'due_at': (new Date).toISOString(),
        'excused': false,
        'id': 'outcomes',
        'late': false,
        'missing':false,
        'name': 'Outcome Results from Learning Mastery',
        'points_possible': points_possible,
        'rubric': rubrics,
        'use_rubric_for_grading': true
    }

    return assignment
}

function getAssignmentNameFromSubmissions(submissions) {
    return submissions[0].assign_name
}

function update_submissions_overview(submissions) {
    try {
        if (submissions.length > 0) {
            let assign_name = getAssignmentNameFromSubmissions(submissions)
            $('div#assign_submissions').html(`<p><b>Score Table</b>. Found ${submissions.length} submissions for <em>${assign_name}</em>.</p><p>The table below can be useful to see marks for this assignment that will be pasted. Click on a student's name to open a speedgrader tab and edit their scores. Click on the column headers ("Name" or "Missing" or one of the Learning Targets) to re-sort the table.</p>`)
        } else {
            $('div#assign_submissions').html(`<p>🥹 No submissions found 🥹</p>`)
        }
    } catch(e) {
        console.log(`update_submissions_overview failed with error ${e}`)
    }
}

function getAssignmentIdFromSubmissions(submissions) {
    return submissions[0].assign_id
}

function getCourseIdFromAssignments(assignments) {
    return assignments[0].course_id
}


function makeSubmissionsTable(submissions, rubrics) {
    // display all submissions accounting for different types of data available.
    // submissions may have scores for rubrics but maybe not...
    //table headers: sortable_name, r1, r2,..., r_n, entered_score, missing, late, excused
    console.log(`Making submissions table with ${submissions.length} submissions and ${rubrics.length} rubrics.`)
    console.table(submissions)
    console.table(rubrics)
    console.log(`base_url: ${base_url}`)
    my_table = `<table id="submissions">\n`
    my_table += '<thead><tr><td class="rotate"><div>Period</div></td><td class="rotate"><div>synergy_id</div></td><td class="rotate"><div>Name</div></td>'
    rubrics.forEach((r) => {
        my_table += `<td class="rotate"><div>${r.alt_code.slice(0,30)}</div></td>`
    })
    let my_cols = ['missing','late','excused','points*']
    my_cols.forEach((col) => {
        my_table += `<td class="rotate"><div>${col}</div></td>`
    })
    my_table += `</tr></thead>\n<tbody>`
    submissions.forEach((s) => {

        // console.log('adding syn_id for submission',s)
        //id
        my_table += `<tr><td>${s.period}</td><td>${s.synergy_id.slice(0,6)}</td>`
        //name + link to speedGrade
        my_table += `<td><a target=_blank href="${base_url}/courses/${s.course_id}/gradebook/speed_grader?assignment_id=${s.assign_id}&student_id=${s.canvas_id}">${s.sortable_name.slice(0,35)}</a></td>`

        if ('rubric_assessment' in s) {
            
            rubrics.forEach((r) =>{
                let rubric_score = ''
                try {
                    rubric_score = s.rubric_assessment[r.id].points
                } catch(e) {
                    console.log(`Error parsing rubric ${e}`)
                } 

                if (rubric_score == undefined) {
                    my_table += `<td class="undefined">???</td>`
                } else {
                    my_table += `<td>${rubric_score}</td>`
                }
        })
        } else {
            rubrics.forEach((r) => {
                // no rubric assessment in submission
                my_table += '<td></td>'
            })
        }
        
        

        // change look of missing/late/excused
        let my_vals = [s.missing, s.late, s.excused]
        my_vals.forEach((val) => {
            let show = ''
            if (val === true) {
                show = '&#x2713;'
                console.log('Submission:',s,'my_vals:',val,'showing',show)
            }
            my_table += `<td>${show}</td>`
        })

        /* points* */
        if (s.entered_score == null) {
            my_table += `<td></td>`
        } else {
            my_table += `<td>${s.entered_score}</td>`
        }

        my_table += `</tr>`
    })

    my_table += '</tbody></table>'

    $('div#assign_submissions').append(my_table)
    var table = new DataTable('table#submissions', {
        order: [[0, 'asc'],[2, 'asc']],
        pageLength: -1, //-1 means "all" :)
        lengthMenu: [[-1, 50, 10], ["All", 50, 10]]
        // scrollY: "300px",
        // scrollCollapse: true,
        // paging: false
    })

    $('table#submissions').addClass('display compact stripe')

    $('div#assign_submissions').append($('<p><b>Points*</b> will not be pasted by the extension, make sure to enter a rubric score.</p>').addClass('point_note'))

    // table.columns.adjust().draw()

    
}

function update_rubric_list(assignments, submissions) {
    let assign_id = getAssignmentIdFromSubmissions(submissions)
    let assignment = getAssignmentById(assignments, assign_id)
    let rubrics = getRubrics(assignment)
    console.log('Rubrics:',rubrics)

    // show rubrics for assignment
    $('div#rubrics_overview').html("<h4>Submissions/Scores for ALT's</h4><ul></ul>")
    rubrics.forEach((r, index) => {
        /*
            summary = {
                'rubric_scores': rubric_scores,
                'entered_score': entered_scores,
                'no_scores': no_scores,
                'missing': missing,
                'late': late,
                'excused': excused,
                'skipped_entirely': skipped_entirely
            }
        */
        let summary = countScoresFromSubmissionsByRubricId(submissions, r.id)
        console.log('Summary from countScores...',summary)

        $('div#rubrics_overview ul').append($('<li></li>').html(`<b>${r.alt_code}</b> - ${r.alt_text} (<em>${summary.rubric_scores.length} scores and ${summary.missing.length} missing</em>)`))

        // let alert_student_total = 0
        // let my_list = []
        // let my_keys = ['no_scores', 'skipped_entirely']
        // my_keys.forEach((key) => {
        //     alert_student_total += summary[key].length

        //     summary[key].forEach((s) => {
        //         my_list.push(`${s.sortable_name} (${s.synergy_id})`)
        //     })
        // })
        // let my_text = `<ul><li><b>${alert_student_total} missing Rubric Scores</b>:<br />${my_list.sort().join("<br />")}</li>`
        // let li = $('<li></li>').html(`<b>${r.alt_code}</b> - ${r.alt_text} (<em>${summary.rubric_scores.length} scores and ${summary.missing.length} missing</em>)`)
        // li.append($('<ul></ul>').addClass('student_list').append(my_text))
        // $('div#rubrics_overview ul').append(li)

        // TODO create display for students with scores and missing scores...

        // See https://datatables.net/examples/basic_init/table_sorting.html

    })   
}

async function process_assign_change(course_id, assignments) {
    let selection = $('#assign_select select').find(':selected')
    let assign_id = selection.val()
    let assign_name = selection.text()
    console.log(`Selection: ${assign_id} and ${assign_name}`)
    let assignment = getAssignmentById(assignments, assign_id)
    let submissions = await getSubmissions(course_id, assignments, assignment.id)
    update_rubric_list(assignments, submissions)
    makeSubmissionsTable(submissions, getRubrics(assignment))
    // $('div#assign_submissions').append(makeSubmissionsTable(submissions, getRubrics(assignment)))
    // new DataTable('table#submissions', {
    //     order: [[1, 'asc']]
    // })
}


async function fetch_assign_click() {
    /* 
        What needs to happen w/ canvas api reads: (Feb 23)
        1. Visit canvas page to ensure authentication
        2. Fetch students (canvas_id => sis_number (synergy)) and assignments list from REST api calls
        3. Prompt user to select a canvas assignment to "copy" (send scores to background.js)
        4. Browse to Synergy (or click over if Synergy CORS policy doesn't block... tbd)
        5. Click on a cell in synergy gradebook column (consider reading existing scores and storing in background.js (to enable undo)
        6. Write scores into synergy.
    */

    /* 
        What needed to happen without canvas api reads:
        1. get zoom level store to initial_zoom
        2. set zoom to 0.25 (causes lazy load on canvas to fetch all data and complete table load) 
        3. send message to content_script to read the (now completed) gradebook
        4. once the gradebook is read restore the zoom level to initial zoom because we now have all canvas grade detail.
    */
    
    let queryOptions = {currentWindow: true, active: true}
    const tabs = await chrome.tabs.query(queryOptions)
    const activeTabId = tabs[0].id
    console.log(`activeTabId: ${activeTabId} \n activeTabUrl ${tabs[0].url}`)

    if (!tabs[0].url.match(/https\:\/\/\w+\.\w+\.instructure\.com\/courses\/\d+\/gradebook/g) & !tabs[0].url.match(/https\:\/\/\w+\.instructure\.com\/courses\/\d+\/gradebook/g)) {
        console.log('Copy only works when viewing a Canvas Gradebook...')
        return(null)
    }

    // TODO: Can we make the assignments window open in Synergy as well as Canvas so you can view paste on same screen?

    /* Fetch assignments */
    // window.location.href.match(/courses\/(\d+)\//)[1]  // (returns course_id)
    course_id = tabs[0].url.match(/courses\/(\d+)\//)[1]
    console.log(`Fetching assignments for course ${course_id}`)
    assignments = await getAssignments(course_id)
    console.log(`assignments: ${assignments.length}... first assignment: ${assignments[0]}`)
    update_assign_select(assignments)
    send_to_background(assignments, 'assignments')
    process_assign_change(course_id,assignments)
    updateMissing()
}

async function clear_button_click() {
    let message = {
        from: 'popup.js',
        to: 'background.js',
        title: 'clear_data',
        body: 'Can you clear the storage?'
    }

    showLoader(true)
    await chrome.runtime.sendMessage(message, (response) => {
        console.log(`Popup asked for clear_data and heard ${response}`)
        update_submissions_overview([])
        $('div#assign_select').html('')
        $('div#rubrics_overview').html('')
        $('div#assign_submissions').html('')
    })
    showLoader(false)
}

/* global scope vars */
let base_url = ''
// const synFakeIds = []
var course_id = 0
var assignments = []
var rubrics = []
var assign_id = 0


$('button#fetch_assign').click(function(){
    fetch_assign_click()
})

$('#clear_btn button').click(() => {
    clear_button_click()
})

function updateRounding(rounded = 0.5) {
    let rounded_txt = String(rounded).slice(1)
    $('#overall_rounding').html(`<p>Rounding <em>up</em> decimals at and above <a href="options.html">${rounded_txt}</a></p>`)
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

async function updateMissing() {
    getMissingPref().then((missingPref) => {
        let description = ''
        switch(missingPref) {
            case 'score':
                description = 'Enter a "N !ex" or "R !ex"'
                break
            case 'comment':
                description = 'Enter "Mi !ex"'
                break
            case 'skip':
                description = "Skip the student"
        }
        $('#missing').html(`<p><b>Missing/Zero Marks in Canvas</b>. When assignment is marked <b>missing</b> or score is <b>0</b>: <a href="options.html">${description}</a></p>`)
    })
}

/*
    When popup is opened, check to see if canvas data already exists in the backbground... 
    and if so, update the popup view.
*/
url = ''
base_url = ''

showLoader(true)

getUrl().then((result) =>{
    url = result
    if (!url.match(/https\:\/\/\w+\.\w+\.instructure\.com\/courses\/\d+\/gradebook/g) & !url.match(/https\:\/\/\w+\.instructure\.com\/courses\/\d+\/gradebook/g)) {
        // not on Canvas... popup should not open.
        $('div#alert')
        .css({'background':'#db222a','color':'white'})
        .html(`<p><b>Popup only works on your canvas gradebook page</b>.</p><p>Please close this page and re-open when you are on your canvas gradebook page.</p>`)
        showLoader(false);
        $('div#content').hide()
    } else {
        $(`div#alert`)
        .css({'background':'#f6ae2d','color':'#4c4b4b'})
        .html(`<p><b>Ready to fetch assignments!</b> Let's goooooo!</p>`)
    
        getBaseUrl().then((result) => {
            base_url = result
        })
        $('div#content').show()
    }
})

showLoader(false)


let my_message_assign = {
    from: 'popup.js',
    to: 'background.js',
    title: 'checking_for_assignments',
    body: 'do you have any assignments?'
}

 chrome.runtime.sendMessage(my_message_assign, (my_assignments) => {
    if (Object.keys(my_assignments).length > 0) {
        assignments = my_assignments;
        course_id = getCourseIdFromAssignments(assignments)
        update_assign_select(my_assignments);
    } else {
        console.log('No assignments from background received by popup.')
    }
})

let my_message = {
    from: 'popup.js',
    to: 'background.js',
    title: 'checking_for_submissions',
    body: 'do you have any submissions?'
}

chrome.runtime.sendMessage(my_message, (response) => {
    let roundUpFrom = response.roundUpFrom
    let missingPref = response.missingPref
    let submissions = response.submissions
    if (Object.keys(submissions).length > 0) {
        if (assignments.length > 0) {
            course_id = getCourseIdFromAssignments(assignments)
            update_rubric_list(assignments, submissions)
            let assign_id = getAssignmentIdFromSubmissions(submissions)
            update_assign_select(assignments, assign_id)
            let assignment = getAssignmentById(assignments, assign_id)
            update_submissions_overview(submissions)
            updateRounding(roundUpFrom)
            updateMissing()
            makeSubmissionsTable(submissions, getRubrics(assignment))
        } else {
            console.log(`submissions received but no assignments sent... problem!`)
        }
    } else {
        console.log('No submissions from background received by popup.')
    }
})