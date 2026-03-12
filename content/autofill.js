// content/autofill.js

/**
 * Check if an input is visible on the page.
 */
function isVisible(input) {
  const style = window.getComputedStyle(input);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    input.offsetWidth > 0 &&
    input.offsetHeight > 0
  );
}

/**
 * Fire synthetic events so React/Vue/Angular sites register the value change.
 */
function fireInputEvents(el, char) {
  // Use native input value setter to bypass React's synthetic event system
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, char);
  } else {
    el.value = char;
  }

  el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  el.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: char, code: `Key${char.toUpperCase()}` })
  );
  el.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, key: char, code: `Key${char.toUpperCase()}` })
  );
}

/**
 * Detect multi-field OTP layout: a group of adjacent single-character inputs.
 * Returns an array of input elements (in order) if found, or null.
 */
function findMultiFieldInputs() {
  // Strategy 1: Look for groups of inputs with maxlength="1" sharing a parent
  const allInputs = Array.from(document.querySelectorAll('input'));
  const singleCharInputs = allInputs.filter(
    (el) => isVisible(el) && (el.maxLength === 1 || el.maxLength === 2)
  );

  if (singleCharInputs.length >= 4) {
    // Group by parent element
    const groups = new Map();
    for (const input of singleCharInputs) {
      const parent = input.parentElement?.parentElement || input.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(input);
    }

    // Find the largest group with 4+ inputs (likely the OTP fields)
    let bestGroup = null;
    for (const [, inputs] of groups) {
      if (inputs.length >= 4 && (!bestGroup || inputs.length > bestGroup.length)) {
        bestGroup = inputs;
      }
    }

    if (bestGroup) return bestGroup;
  }

  // Strategy 2: Look for inputs with OTP-related attributes that have maxlength="1"
  const otpSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp"]', 'input[id*="otp"]',
    'input[name*="code"]', 'input[id*="code"]',
    'input[name*="pin"]', 'input[id*="pin"]',
    'input[name*="digit"]', 'input[id*="digit"]',
    'input[name*="verification"]', 'input[id*="verification"]',
  ];

  for (const selector of otpSelectors) {
    const matches = Array.from(document.querySelectorAll(selector)).filter(
      (el) => isVisible(el) && (el.maxLength === 1 || el.maxLength === 2)
    );
    if (matches.length >= 4) return matches;
  }

  // Strategy 3: Look for adjacent inputs of the same type/class with small width
  const narrowInputs = allInputs.filter((el) => {
    if (!isVisible(el)) return false;
    const w = el.offsetWidth;
    return w > 10 && w < 70 && (el.maxLength <= 2 || el.size <= 2);
  });

  if (narrowInputs.length >= 4) {
    // Check that they share a common parent or grandparent
    const parent = narrowInputs[0].parentElement;
    const sameParent = narrowInputs.filter(
      (el) => el.parentElement === parent || el.parentElement?.parentElement === parent?.parentElement
    );
    if (sameParent.length >= 4) return sameParent;
  }

  return null;
}

/**
 * Find a single OTP input field (original logic).
 */
function findSingleOtpInput() {
  const selectors = [
    'input[autocomplete="one-time-code"]',
    'input[type="text"][maxlength="6"]',
    'input[type="text"][maxlength="8"]',
    'input[type="number"][maxlength="6"]',
    'input[type="text"][inputmode="numeric"]',
    'input[type="tel"]',
    'input[name*="otp"], input[id*="otp"]',
    'input[name*="code"], input[id*="code"]',
    'input[name*="pin"], input[id*="pin"]',
    'input[name*="verification"], input[id*="verification"]',
    'input[name*="token"], input[id*="token"]',
    'input[type="password"]',
  ];

  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll(selector)).filter(isVisible);
    if (inputs.length > 0) return inputs[0];
  }

  return null;
}

/**
 * Fill OTP into multi-field inputs (one character per field).
 */
function fillMultiField(inputs, otp) {
  const chars = otp.split("");
  const count = Math.min(chars.length, inputs.length);
  let filled = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs[i];
    try {
      input.focus();
      fireInputEvents(input, chars[i]);
      filled++;
    } catch (e) {
      console.error(`Error filling field ${i}:`, e);
    }
  }

  // Focus the last filled field (or the next empty one)
  if (filled > 0 && inputs[filled - 1]) {
    inputs[filled - 1].focus();
  }

  if (filled === count) {
    return { success: true, message: `OTP filled across ${filled} fields` };
  } else {
    return {
      success: false,
      message: `Only filled ${filled} of ${count} fields`,
    };
  }
}

/**
 * Fill OTP into a single input field (original logic, improved).
 */
function fillSingleField(input, otp) {
  try {
    const oldValue = input.value;
    input.focus();
    fireInputEvents(input, otp);

    if (input.value === otp || input.value === oldValue + otp) {
      return { success: true, message: "OTP filled successfully" };
    } else {
      return {
        success: false,
        message: "Could not set OTP (website may have prevented it)",
      };
    }
  } catch (error) {
    console.error("Error filling OTP:", error);
    return { success: false, message: error.message };
  }
}

/**
 * Main fill function: tries multi-field first, then single-field.
 */
function fillOtp(otp) {
  // Try multi-field first
  const multiFields = findMultiFieldInputs();
  if (multiFields && multiFields.length >= otp.length) {
    return fillMultiField(multiFields, otp);
  }

  // Fall back to single-field
  const singleInput = findSingleOtpInput();
  if (singleInput) {
    return fillSingleField(singleInput, otp);
  }

  // If multi-fields were found but fewer than OTP length, try anyway
  if (multiFields) {
    return fillMultiField(multiFields, otp);
  }

  return { success: false, message: "No OTP input field found on this page" };
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "AUTOFILL_OTP" && request.otp) {
    const result = fillOtp(request.otp);
    sendResponse(result);
  }
  return true;
});
