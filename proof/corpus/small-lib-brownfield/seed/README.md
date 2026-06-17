# slugify

Turn a string into a URL-safe slug.

```js
const { slugify } = require("slugify");

slugify("Hello World"); // => "hello-world"
slugify("  ?Trim Me?  "); // => "trim-me"
```

## API

### `slugify(text: string): string`

Lower-cases `text`, replaces runs of non-alphanumeric characters with a single
hyphen, and strips leading/trailing hyphens. Throws `TypeError` on non-string
input.

## Tests

```sh
npm test
```
