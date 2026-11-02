'use strict';

// 统一错误码（沿用 goofish 结构）
const CODES = {
  OK: 0,
  PARAM: 400,
  NOT_FOUND: 404,
  RISK_CONTROL: 429,
  INTERNAL: 500,
};

class ApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

module.exports = { ApiError, CODES };
