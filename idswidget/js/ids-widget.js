var base64query = btoa('{"filter":{"isDeleted":false,"freetext":".ifc"},"timeZone":"Europe/Stockholm"}');
var jsondata = '';

document.addEventListener('DOMContentLoaded', function() {
  console.log("IDS Widget loaded");

  StreamBIM.connect().then(function () {
    console.log("StreamBIM connected");
    StreamBIM.setStyles(".color-code-values--left-sliders-active {margin-left: 40%;}");
    
    StreamBIM.getProjectId().then((result) => {
        // Implementera document Label in till populateSelectElement
        projectID = result;
        
        StreamBIM.makeApiRequest({url: 'https://app.streambim.com/project-'+projectID+'/api/v1/documents/export/json/?query='+base64query})

        .then(response => JSON.parse(response))
        .then(documentObjects => populateSelectElement(documentObjects))
        .catch(error => console.error(error));

        document.addEventListener("click", function(event) {
          if (event.target.classList.contains("goto-btn")) {
            gotoObject(event.target.dataset.guid);
          } else if (event.target.classList.contains("highlight") && event.target.classList.contains("element")) {
            highlightObject(event.target.dataset.guid);
          } else if (event.target.classList.contains("highlight") && event.target.classList.contains("grouped_clashes")) {
            highlightGroup(event.target.dataset.groupIndex);
          } else if (event.target.classList.contains("highlight") && event.target.classList.contains("model_clashes")) {
            highlightModelClashes(event.target.dataset.groupIndex);
          } else if (event.target.classList.contains("highlight") && event.target.classList.contains("failed_entities")) {
            highlightFailedEntities(event.target.dataset.specIndex, event.target.dataset.reqIndex);
          } else if (event.target.classList.contains("copy-btn")) {
            copyToClipboard(event.target);
          } else if (event.target.classList.contains("copy-btn") && event.target.classList.contains("failed_entities")) {
            copyToClipboardEntities(event.target, event.target.dataset.specIndex, event.target.dataset.reqIndex);
          }
        });
        
    }).catch((error) => console.error(error));
  }).catch((error) => console.error(error));
});

function populateSelectElement(json) {
  console.log(json);
  var select = document.querySelector('select[name="ifc_filename"]');
  
  // Clear existing options except the first one
  while (select.options.length > 1) {
      select.remove(1);
  }

  // Add the select element to the page
  json.data.forEach(function(item) {
    var option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.filename;
    option.dataset.idsFilename = item.filename;
    option.dataset.uploadDate = item.uploadedDate;
    option.dataset.filesize = item.filesize;

    const modelLabel = item.labels.find(label => label.id === 1007);
    if (modelLabel) {
      option.dataset.idsFilename = modelLabel.id;
    }
    
    if(item.revisions && item.revisions.length > 1) {
      var lastRevision = item.revisions[1];
      option.dataset.revId = lastRevision.revision;
    }
    select.appendChild(option);
  });
    // Add the change event handler

  select.addEventListener('change', function() {
    // Check if the selected option has a value
    if (this.value) {
      // Find the empty option and remove it
      select.querySelector('option:not([value])')?.remove();
          
      // Get the selected option's value (the ID)
      var documentID = this.value;
      // Get the selected option's text (the filename)
      var filename = select.options[select.selectedIndex].text;
      // Extract the file extension from the filename
      var uploadedDate = select.options[select.selectedIndex].dataset.uploadDate;
      var filesize = select.options[select.selectedIndex].dataset.filesize;

      StreamBIM.makeApiRequest({ url: 'https://app.streambim.com/project-' + projectID + '/api/v1/documents/' + documentID + '/downloadlink' })
        .then((downloadlink) => {
          // Disable the select element while waiting for the response
          select.disabled = true;

          // Show a loading indicator
          const loadingIndicator = document.createElement('div');
          loadingIndicator.id = 'loading-indicator';
          loadingIndicator.textContent = 'Loading...';
          select.parentNode.insertBefore(loadingIndicator, select.nextSibling);

          fetch('/validate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              projectID: projectID,
              downloadlink: 'https://app.streambim.com/project-' + projectID + '/api/v1/' + downloadlink,
              filename: filename,
              uploadDate: uploadedDate,
              fileSize: filesize
            })
          })
          .then(response => response.json())
          .then(data => {
            // Remove the loading indicator
            const loadingIndicator = document.getElementById('loading-indicator');
            if (loadingIndicator) {
              loadingIndicator.remove();
            }
            if (typeof data === 'object') { // This means it's JSON
              jsondata = JSON.parse(data.report);
              // Determine the template to use based on the document name
              let templateId = 'json-template-IDS';

              // Use the determined template
              const templateScript = document.getElementById(templateId).innerHTML;
              const template = Handlebars.compile(templateScript);
              const html = template(jsondata);

              document.addEventListener("click", function(event) {
                if (event.target.classList.contains("summary-toggle")) {
                  var detailsElement = event.target.closest('details');
              
                  if (detailsElement.hasAttribute('open')) {
                      // If details are open, clear the content and close the details
                      var reqIndex = event.target.dataset.reqIndex;
                      var specIndex = event.target.dataset.specIndex;
                      document.getElementById('table-container-' + specIndex + '-' + reqIndex).innerHTML = '';
                      document.querySelector('.load-more[data-spec-index="' + specIndex + '"][data-req-index="' + reqIndex + '"]').style.display = 'none';
                  } else {
                      // If details are closed, load content
                      var reqIndex = event.target.dataset.reqIndex;
                      var specIndex = event.target.dataset.specIndex;
                      var context = jsondata.specifications[specIndex].requirements[reqIndex];
                      var templateScript = document.getElementById('json-template-IDS-requirement').innerHTML;
                      var template = Handlebars.compile(templateScript);
              
                      var initialRows = context.failed_entities.slice(0, 100);
                      var html = template({failed_entities: initialRows});
                      document.getElementById('table-container-' + specIndex + '-' + reqIndex).innerHTML = html;
              
                      if (context.failed_entities.length > 100) {
                          document.querySelector('.load-more[data-spec-index="' + specIndex + '"][data-req-index="' + reqIndex + '"]').style.display = 'block';
                      }
                  }
                }
              });
            
              document.addEventListener("click", function(event) {
                if (event.target.classList.contains("load-more")) {
                  var reqIndex = event.target.dataset.reqIndex;
                  var specIndex = event.target.dataset.specIndex;
                  var context = jsondata.specifications[specIndex].requirements[reqIndex];
              
                  // Determine the current count of loaded rows
                  var currentCount = document.querySelectorAll('#table-container-' + specIndex + '-' + reqIndex + ' .row-class').length;
                  console.log(currentCount);
                  // Slice the next 100 rows based on the currentCount
                  var additionalRows = context.failed_entities.slice(currentCount, currentCount + 100);
                  var templateScript = document.getElementById('json-template-IDS-requirement').innerHTML;
                  var template = Handlebars.compile(templateScript);
                  var html = template({failed_entities: additionalRows});
              
                  document.getElementById('table-container-' + specIndex + '-' + reqIndex).insertAdjacentHTML('beforeend', html);
              
                  // Hide 'Load More' button if all rows are loaded
                  if (currentCount + 100 >= context.failed_entities.length) {
                      event.target.style.display = 'none';
                  }
                }
              });
          
              document.getElementById("report").innerHTML = html;
              
            } else {
              // If it's not JSON, assume it's HTML or text
              console.log("data recieved not json");
            }
          })
          .catch(error => {
            console.error(error);
          });
          
        }).catch(function(error) {
          logError('getProjectId', error);
        });

    } 
  });
}

// Helper function to get the value of a given key in an array of objects
function getValue(properties, key) {
  const property = properties.find(property => property.key === key);
  return property && property.hasOwnProperty("value") ? property.value : "";
}

// Helper function to find the value of a given key in an object
function findKey(obj, key) {
  for (const prop in obj) {
      if (prop === key) {
          return obj[prop];
      } else if (typeof obj[prop] === 'object') {
          const result = findKey(obj[prop], key);
          if (result !== undefined) {
              return result;
          }
      }
  }
  return undefined;
}



// helper to go to object (IDS report)
function gotoObject(guid){
  StreamBIM.gotoObject(guid);
}

// helper to copy element tag to clipboard
function copyToClipboard($this) {
  var bimId = $this.dataset.tag; // Use .data() instead of .attr() for data attributes

  // Change the button to show only the BIM ID
  $this.title = 'Copied '+bimId;

  // Create a temporary text area to hold the value to be copied
  var tempTextArea = document.createElement('textarea');
  tempTextArea.value = bimId;
  document.body.appendChild(tempTextArea);
  tempTextArea.select();

  try {
    var successful = document.execCommand('copy');
    console.log('Copying text command was ' + (successful ? 'successful' : 'unsuccessful'));
  } catch (err) {
    console.error('Oops, unable to copy', err);
  }

  document.body.removeChild(tempTextArea);

  // Set a timeout to revert the button HTML content back to its original state after 2 seconds
  setTimeout(function() {
    $this.title = "Click to copy the ID. Use 'Select Elements by ID' in Revit";
  }, 2000);

};
// helper to copy element tags to clipboard
function copyToClipboardEntities($this, specIndex, reqIndex) {

  const failedEntities = jsondata.specifications[specIndex].requirements[reqIndex].failed_entities;

  let guids = new Set(failedEntities.map(entity => entity.tag));
  bimId = Array.from(guids).join(',').toString();
  console.log(bimId);

  // Change the button to show only the BIM ID
  $this.title = 'Copied!';

  // Create a temporary text area to hold the value to be copied
  var tempTextArea = document.createElement('textarea');
  tempTextArea.value = bimId;
  document.body.appendChild(tempTextArea);
  tempTextArea.select();

  try {
    var successful = document.execCommand('copy');
    console.log('Copying text command was ' + (successful ? 'successful' : 'unsuccessful'));
  } catch (err) {
    console.error('Oops, unable to copy', err);
  }

  document.body.removeChild(tempTextArea);

  // Set a timeout to revert the button HTML content back to its original state after 2 seconds
  setTimeout(function() {
    $this.title = "Click to copy the ID. Use 'Select Elements by ID' in Revit";
  }, 2000);

};

// helper to highlight failed entities (IDS report)
function highlightFailedEntities(specIndex, reqIndex) {

  const failedEntities = jsondata.specifications[specIndex].requirements[reqIndex].failed_entities;

  let guids = new Set(failedEntities.map(entity => entity.global_id));

  // Create the query with rules based on the unique GUIDs
  let query = {
    rules: Array.from(guids).map(guid => ([{
        buildingId: "1000",
        propValue: guid,
        operator: "",
        propKey: "GUID"
    }]))
  };
  var pset = null;
  var propertyKey = "File Name";
  // Apply the search and visualization based on the GUIDs
  StreamBIM.applyObjectSearch(query).then( (result) => {
    console.log(query);
    console.log(result);
    StreamBIM.colorCodeByProperty({pset, propertyKey}).then( () => {
      StreamBIM.setSearchVisualizationMode('FADED');
      StreamBIM.zoomToSearchResult();
    });
  }).catch( (error) => {console.error(error)});

}


// helper to highlight individual object (clash reports)
function highlightObject(guid){
  StreamBIM.gotoObject(guid);
  var query = {
    key: "GUID",
    value: guid
  };

  var pset = null;
  var propertyKey = "Type";
  // Apply the search and visualization based on the GUIDs
  StreamBIM.applyObjectSearch(query).then( () => {
    // StreamBIM.colorCodeByProperty({pset, propertyKey}).then( () => {
    //   StreamBIM.setSearchVisualizationMode('FADED');
    //   StreamBIM.zoomToSearchResult();
    // });
    StreamBIM.setSearchVisualizationMode('FADED');
    StreamBIM.zoomToSearchResult();
    
  }).catch( (error) => {console.error(error)});
}

// helper to highlight grouped objects (clash reports)
function highlightGroup(index) {
  let guids = new Set();

  // Iterate over all clash types and their groups
  for (let clashType in jsondata) {
    if (jsondata.hasOwnProperty(clashType)) {
      jsondata[clashType].forEach(groupArray => {
        for (let group in groupArray) {
          if (group === index) {
            groupArray[group].forEach(pair => pair.forEach(guid => guids.add(guid)));
          }
        }
      });
    }
  }

  // Create the query with rules based on the GUIDs
  let query = {
    rules: Array.from(guids).map(guid => ([{
      buildingId: "1000",
      propValue: guid,
      operator: "",
      propKey: "GUID"
    }]))
  };

  var pset = null;
  var propertyKey = "File Name";
  // Apply the search and visualization based on the GUIDs
  StreamBIM.applyObjectSearch(query).then( () => {
    StreamBIM.colorCodeByProperty({pset, propertyKey}).then( () => {
      StreamBIM.setSearchVisualizationMode('FADED');
      StreamBIM.zoomToSearchResult();
    });
  }).catch( (error) => {console.error(error)});
}
// Handlebars helper functions
Handlebars.registerHelper('formatKey', function(key) {
  return key.split('.')[0];
});
Handlebars.registerHelper('anyTags', function(failedEntities, options) {
  // Check if any 'failed_entities' have a 'tag' property that's not empty or null
  const hasTags = failedEntities.some(entity => entity.tag);
  return hasTags ? options.fn(this) : options.inverse(this);
});

Handlebars.registerHelper('keyOfFirstProperty', function(context) {
  return Object.keys(context)[0];
});