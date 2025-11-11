// content/autofill.js

// Try to find the most likely OTP input field on the page
function findOtpInput() {
  // Common OTP input selectors
  const selectors = [
    // Single input field for OTP
    'input[type="text"][maxlength="6"]',
    'input[type="number"][maxlength="6"]',
    'input[type="text"][inputmode="numeric"]',
    'input[type="tel"]',
    // Look for fields with common OTP-related names/ids
    'input[name*="otp"], input[id*="otp"]',
    'input[name*="code"], input[id*="code"]',
    'input[name*="pin"], input[id*="pin"]',
    'input[name*="verification"], input[id*="verification"]',
    // Look for the first password field if nothing else is found
    'input[type="password"]'
  ];

  // Try each selector until we find a match
  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll(selector));
    // Filter out hidden inputs and those that are too small to be OTP fields
    const visibleInputs = inputs.filter(input => {
      const style = window.getComputedStyle(input);
      return style.display !== 'none' && 
             style.visibility !== 'hidden' &&
             input.offsetWidth > 0 && 
             input.offsetHeight > 0;
    });
    
    if (visibleInputs.length > 0) {
      // If we find multiple matches, try to pick the most likely one
      return visibleInputs[0];
    }
  }

  return null;
}

// Fill the OTP field and trigger appropriate events
function fillOtp(otp) {
  const input = findOtpInput();
  if (!input) {
    return { success: false, message: 'No OTP input field found' };
  }

  try {
    // Store the current value to check if it changes
    const oldValue = input.value;
    
    // Set the value
    input.value = otp;
    
    // Trigger input and change events to ensure the website registers the change
    const events = ['input', 'change', 'keydown', 'keyup', 'keypress'];
    events.forEach(eventType => {
      input.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
    });
    
    // Focus the input
    input.focus();
    
    // Check if the value was actually set (some sites might prevent it)
    if (input.value === otp || input.value === oldValue + otp) {
      return { success: true, message: 'OTP filled successfully' };
    } else {
      return { 
        success: false, 
        message: 'Could not set OTP (website may have prevented it)' 
      };
    }
  } catch (error) {
    console.error('Error filling OTP:', error);
    return { success: false, message: error.message };
  }
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'AUTOFILL_OTP' && request.otp) {
    const result = fillOtp(request.otp);
    sendResponse(result);
  }
  return true; // Keep the message channel open for async response
});
