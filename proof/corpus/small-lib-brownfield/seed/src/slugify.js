"use strict";

/**
 * Turn an arbitrary string into a lower-case, URL-safe slug:
 * trim, lower-case, replace runs of non-alphanumeric characters with a single
 * hyphen, and strip leading/trailing hyphens.
 *
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  if (typeof text !== "string") {
    throw new TypeError("slugify: expected a string");
  }
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

module.exports = { slugify };
