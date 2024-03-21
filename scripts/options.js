// Saves options to chrome.storage
function updateExplanation(value) {
    let example = Math.round((2 + value)*100)/100
    let example_result = 3
    let example_2 = Math.round((2 + value - 0.01)*100)/100
    $('#explanation').html(`<p>With this value set, a score of <b>${example}</b> will round to <b>${example_result}</b>. And a score of <b>${example_2}</b> will round to <b>2</b>.}`)
}

$(function() {
    $("#rounding").slider({
        value:0.5,
        min: 0.01,
        max: 0.99,
        step: 0.01,
        slide: function(event, ui) {
            $("#amount").val(ui.value )
            updateExplanation(ui.value)
        }
    })
    .css("width","50%")

    $("#amount").val($("#rounding").slider("value"))
})

$('#amount').on('input',() => {
    try {
        let val = parseFloat($('#amount').val())
        if (typeof val == 'number') {
            console.log(`Received input, rounding set to ${val}`)
            $('#rounding').slider('value',val)
            updateExplanation(val)
        }
    } catch(e) {
        console.log('must be a number')
    }
    
})




if (window.history.length > 1) {
  $('#back').text('Back')
  $('#back').on('click',() => {
    window.history.go(-1)
  })
} else {
  $('#back').text('Close tab')
  $('#back').on('click',() => {
    window.close()
  })
}



const saveOptions = () => {
  var rounding = $('#rounding').slider('value');
  var missing = $('#missing input[type="radio"][name="missing"]:checked').val();
    console.log(`Save options w/ rounding = ${rounding}\n missing = ${missing}`)
  chrome.storage.sync.set(
    { 
        roundUpFrom: rounding,
        missingPref: missing
    },
    () => {
      // Update status to let user know options were saved.
      const status = document.getElementById('status')
      status.textContent = 'Options saved.'
      setTimeout(() => {
        status.textContent = ''
      }, 750)
    }
  )
}

// Restores select box and checkbox state using the preferences
// stored in chrome.storage.
const restoreOptions = () => {
  chrome.storage.sync.get(
    keys = {
        roundUpFrom: 0.5,
        missingPref: "skip"
    },
    (items) => {
        let rounding = items.roundUpFrom
        console.log(`Setting rounding to ${rounding}...`)
        $('#rounding').slider('value', rounding)
        $("#amount").val($("#rounding").slider("value"))
        updateExplanation(rounding)

        let missing = items.missingPref
        console.log(`Setting missing pref to ${missing}...`)
        console.log($(`#missing input:radio[value="${missing}"]`))
        $(`#missing input:radio[value="${missing}"]`).trigger('click')
    }
  )
}

document.addEventListener('DOMContentLoaded', restoreOptions)
document.getElementById('save').addEventListener('click', saveOptions)