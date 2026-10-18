// JSDoc collection: description, numeric/string constraint tags, @default, top-level type descriptions.
/**
 * A validated registration form.
 */
interface Registration {
  /**
   * Chosen username.
   * @minLength 3
   * @maxLength 20
   * @pattern ^[a-z0-9_]+$
   */
  username: string;
  /**
   * Age in years.
   * @minimum 13
   * @exclusiveMaximum 130
   */
  age: number;
  /**
   * Contact email.
   * @format email
   */
  email: string;
  /**
   * Interests.
   * @minItems 1
   * @maxItems 5
   */
  interests: string[];
  /**
   * Whether to subscribe to the newsletter.
   * @default false
   */
  subscribe: boolean;
}

const g = agent("g");
const registration = await g.ask<Registration>("fill the form");
log(JSON.stringify(registration));
