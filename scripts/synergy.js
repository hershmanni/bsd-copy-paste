/*
    Synergy.js provides functions to identify a column of marks (w/ student_id, and assignment name) 
    and copy into a column in Synergy ensuring a match between score student_id.
    Maybe force match between assignment name or not...
    ideally - read values before copy and store them, would provide an "undo" function
    So that after a paste, if user discovers they worked with wrong column, 
    Then they could paste original to reset column values.
*/

const delay = ms => new Promise(res => setTimeout(res, ms))

/**
* Retrieve active element of document and preserve iframe priority MULTILEVEL!
* @return HTMLElement
**/

var getActiveElement = function( document ){
    document = document || window.document

    // Check if the active element is in the main web or iframe
    if( document.body === document.activeElement 
       || document.activeElement.tagName == 'FRAME' ){
        // Get iframes
        var iframes = document.getElementsByTagName('frame')
        for(var i = 0; i<iframes.length; i++ ){
            // Recall
            var focused = getActiveElement( iframes[i].contentWindow.document )
            if( focused !== false ){
                return focused // The focused
            }
        }
    }

    else return document.activeElement
    return false
}

const waitFor = (ms) => new Promise(r => setTimeout(r, ms));

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array)
    }
}

// based on https://stackoverflow.com/a/52771137
// content_script is running in different scope that console... I am accessing a different window object!!!!
// function codeToInject() {
//     // Do here whatever your script requires. For example:
//     window.frames[0]
//     .jQuery('.dx-datagrid-rowsview table')
//     .find('tr[aria-rowindex="6"] td[aria-colindex="11"] div.asgn-cell-wrap')
//     .click()
//     .find('input')
//     .val(4)
//     .trigger('change');
// }


// TODO: update late/missing/exc processing
const add_comment_codes_to_score = (score, roundUpFrom, missingPref, use_cgr) => {
    let my_score = score.score

    // Outcome scores are coming in rounded... fix that with rounding the score
    let rounded_score = ''
    try {
        if (['CI','G','R','N',''].includes(my_score)) {
            rounded_score = my_score
        } else {
            // rounded_score = Math.round(my_score)
            // rick's suggestion on rounding

            if (my_score - Math.floor(my_score) < roundUpFrom) {
                rounded_score = Math.floor(my_score)
            } else {
                rounded_score = Math.round(my_score)
            }

        }
    } catch(e) {
        console.log(`${my_score} hit error while rounding`, e)
        rounded_score = my_score
    }

    // console.log('my_score and rounded_score', my_score, rounded_score)
    
    // console.log('Testing score values',score,rounded_score, score.excused, score.missing, score.late)

    if (score.excused) {
        return (`! ex`)
    }

    // TODO fix handling of rounded_score. Move to options - give option of 0 == N or Missing (for non behavior targets)
    if (score.missing | rounded_score === 0) {
        console.log(`Processing missing/0 with missingPref: ${missingPref} || and use_cgr: ${use_cgr}`)
        switch(missingPref) {
            case "comment":
                return('mi !ex')
                break
            case "score":
                if (use_cgr) return 'R !ex'
                else return('N !ex')
            case "skip":
                return(null)
            default:
                return('SKIP')
        }
        
    }

    if (score.late) {
        return(`${rounded_score} la !ex`)
    }

    return(`${rounded_score} ! !ex`) // score is not exc, missing, late in canvas
}

function getScore(scores, id) {
    let my_score = null
    scores.forEach((score) => {
        // console.log(`Do these match? ${score.sis_number} and ${id}? ${score.sis_number == id ? "yes" : "no"}`)
        if (score.synergy_id == id) {
            my_score = score
        }
    });
    return(my_score)
}
function synergy_env_ready() {
    let ready = false
    let grade_detail_default = $(window.frames[0].document).find('div.dx-switch-handle').eq(0).attr('style').match(/\d+/)[0] == '100' ? true : false
    console.log(`grade_detail (100 means Default which is required): ${grade_detail_default}`)
    if (!grade_detail_default) {
        console.log('Need Grade detail set to Default (100)... hold please.')
        $(window.frames[0].document).find('div.dx-switch-handle').eq(0)[0].click() // switch to Default Grade detail.
    } else {
        ready = true
    }

    let grade_detail_off = $(window.frames[0].document).find('div.dx-switch-handle').eq(1).attr('style').match(/\d+/)[0] == '0' ? true : false
    if (!grade_detail_off) {
        ready = false
        console.log('Need grade detail "off"... hold please')
        $(window.frames[0].document).find('div.dx-switch-handle').eq(1)[0].click()
    } 
    return(ready)
}

async function synergy_paste(scores, roundUpFrom, missingPref, use_cgr) {
    console.log('Processing synergy paste with scores...',scores)

    let col_index = $(window.frames[0].document.activeElement).closest('td').attr('aria-colindex')
    let synergy_scores_table = $(window.frames[0].document).find('.dx-datagrid-rowsview table').eq(0)

    //Fetch grade detail settings
    // console.log(`Grade detail... ${$('div.dx-switch-handle').eq(0).attr('style').match(/\d+/)[0] == '100' ? 'Default' : 'Basic'}`)

    // console.log('table: ',synergy_scores_table[0]);
    // console.log('ids: ', synergy_scores_table.find('span.student-perm-id'));
    var score_ids = []
    var max_score = 0
    scores.forEach((score) => {
        max_score = Math.max(max_score, score.score)
        score_ids.push(score.synergy_id)
    })

    scores.forEach((score) => {
        score.score = add_comment_codes_to_score(score, roundUpFrom, missingPref, use_cgr)
        console.log(`Score found ${score.score}`)
    })


    // console.log(`score_ids ${score_ids} & col: ${col_index}`);
    // console.log(`synergy_scores_table: ${synergy_scores_table}`)

    let synergy_ids = []
    synergy_scores_table.find('span.student-perm-id').each((index, element) => {
        // console.log(`id (${index}): ${element.tagName}`);
        let thisId = $(element).html()
        if (score_ids.includes(thisId)) {
            synergy_ids.push(thisId)
        } 
    })
    // TODO -- build array of student ids that we have scores for... then build async for loop so that requests dont coincide.

    // console.log('synergy_ids: ',synergy_ids);
    // console.log('Synergy col: ', col_index);

    await asyncForEach(synergy_ids, async (id) => {
        let score = getScore(scores, id)
        
        if (score != null & !((score.missing || score.score === 0) & missingPref == 'skip')) {    
            let row_index = synergy_scores_table.find('span.student-perm-id:contains("'+id+'")').closest('tr').attr('aria-rowindex')

            let message = {
                to: 'background.js',
                from: 'synergy.js',
                title: 'inject',
                score: score.score,
                late: score.late,
                excused: score.excused,
                missing: score.missing,
                synergy_id: id,
                row: row_index,
                col: col_index,
                //injectScript: "scripts/synergy-inject.js"
            }

            // console.log('Sending message...:',message)
            await chrome.runtime.sendMessage(
                message, 
                (response) => {
                    // console.log('Sent message:')
                    // console.log(message)
                    // console.log(`synergy.js inject ${message.synergy_id} = ${message.score} received response: ${response}`)
                }
            )

        } else {
            console.log(`No score found for synergy_id: ${id}`)
        }
    })

    return(`Attempted to push ${synergy_ids.length} scores.`)
}

function myListener(request, sender, sendResponse) {
    console.log(`Message received by synergy.js: from: ${request.from} title: ${request.title}`)
    if (request.from == 'background.js' & request.to == 'synergy.js' & request.title == 'synergy_paste') {
        // process synergy paste from background.js + contextMenu click
        console.log(`Synergy.js received request from background with request.attachment:`)
        console.log(request.attachment)
        if (synergy_env_ready()) {
            synergy_paste(request.attachment, request.roundUpFrom, request.missingPref, request.use_cgr)
            .then((response) =>{
                sendResponse('Synergy.js made you a paste!')
            })
        } else {
            sendResponse('Prepare Synergy env and try again!')
        }
    }
    return true // is this firing before response??
}

if (!chrome.runtime.onMessage.hasListener(myListener)) {
    console.log('No listener found by Synergy.js... adding myListener...')
    chrome.runtime.onMessage.addListener(myListener)
} else {
    console.log('Listener already exists! Nothing to do :)')
}
