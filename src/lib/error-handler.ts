/**
 * Error Handler Utility
 * Provides structured error responses with error codes and types
 */

export enum ErrorCode {
  // Validation Errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  MISSING_FIELDS = 'MISSING_FIELDS',
  INVALID_INPUT = 'INVALID_INPUT',
  
  // Authentication Errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  
  // Rate Limiting (429)
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  
  // Scraping Errors (500)
  SCRAPING_FAILED = 'SCRAPING_FAILED',
  CALENDAR_NOT_FOUND = 'CALENDAR_NOT_FOUND',
  BROWSER_ERROR = 'BROWSER_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  SLOT_NOT_FOUND = 'SLOT_NOT_FOUND',
  /** Chili Piper: no bookable slot within configured ±minutes window (HTTP 203). */
  SLOT_WINDOW_EXHAUSTED = 'SLOT_WINDOW_EXHAUSTED',
  DAY_BUTTON_NOT_FOUND = 'DAY_BUTTON_NOT_FOUND',
  
  // Concurrency Errors (503)
  QUEUE_FULL = 'QUEUE_FULL',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  
  // Timeout Errors (504)
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
  OPERATION_TIMEOUT = 'OPERATION_TIMEOUT',
  
  // Generic Errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

export enum ErrorType {
  CLIENT_ERROR = 'CLIENT_ERROR',      // 4xx
  SERVER_ERROR = 'SERVER_ERROR',      // 5xx
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',    // 504
  SERVICE_ERROR = 'SERVICE_ERROR'    // 503
}

export enum SuccessCode {
  SCRAPING_SUCCESS = 'SCRAPING_SUCCESS',
  OPERATION_SUCCESS = 'OPERATION_SUCCESS',
  REQUEST_PROCESSED = 'REQUEST_PROCESSED'
}

export interface ErrorResponse {
  success: false;
  status: number;
  code: ErrorCode;
  timestamp: string;
  requestId?: string;
  responseTime: number; // Time in milliseconds from request received to response sent
  error: {
    type: ErrorType;
    message: string;
    details?: string;
    metadata?: Record<string, any>;
  };
}

export interface SuccessResponse<T = any> {
  success: true;
  status: number;
  responseTime: number; // Time in milliseconds from request received to response sent
  code: SuccessCode;
  data: T;
  timestamp?: string;
  requestId?: string;
}

export type ApiResponse<T = any> = SuccessResponse<T> | ErrorResponse;

export class ErrorHandler {
  /**
   * Create a structured error response
   */
  static createError(
    code: ErrorCode,
    message: string,
    details?: string,
    metadata?: Record<string, any>,
    requestId?: string,
    responseTime?: number
  ): ErrorResponse {
    const type = this.getErrorType(code);
    const status = this.getStatusCode(code);
    
    return {
      success: false,
      status,
      code,
      timestamp: new Date().toISOString(),
      requestId,
      responseTime: responseTime || 0,
      error: {
        type,
        message,
        details,
        metadata
      }
    };
  }

  /**
   * Get HTTP status code from error code
   */
  static getStatusCode(code: ErrorCode): number {
    switch (code) {
      case ErrorCode.VALIDATION_ERROR:
      case ErrorCode.MISSING_FIELDS:
      case ErrorCode.INVALID_INPUT:
        return 400;
      
      case ErrorCode.UNAUTHORIZED:
      case ErrorCode.INVALID_API_KEY:
        return 401;
      
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        return 429;

      /** Project-specific: Chili Piper no bookable slot in ±fallback window (not RFC 203 semantics). */
      case ErrorCode.SLOT_WINDOW_EXHAUSTED:
        return 203;

      case ErrorCode.QUEUE_FULL:
      case ErrorCode.SERVICE_UNAVAILABLE:
        return 503;
      
      case ErrorCode.REQUEST_TIMEOUT:
      case ErrorCode.OPERATION_TIMEOUT:
        return 504;
      
      default:
        return 500;
    }
  }

  /**
   * Get HTTP status code for success responses (always 200)
   */
  static getSuccessStatusCode(): number {
    return 200;
  }

  /**
   * Get error type from error code
   */
  private static getErrorType(code: ErrorCode): ErrorType {
    if ([ErrorCode.VALIDATION_ERROR, ErrorCode.MISSING_FIELDS, ErrorCode.INVALID_INPUT, 
         ErrorCode.UNAUTHORIZED, ErrorCode.INVALID_API_KEY, ErrorCode.RATE_LIMIT_EXCEEDED].includes(code)) {
      return ErrorType.CLIENT_ERROR;
    }
    
    if ([ErrorCode.QUEUE_FULL, ErrorCode.SERVICE_UNAVAILABLE].includes(code)) {
      return ErrorType.SERVICE_ERROR;
    }
    
    if ([ErrorCode.REQUEST_TIMEOUT, ErrorCode.OPERATION_TIMEOUT].includes(code)) {
      return ErrorType.TIMEOUT_ERROR;
    }
    
    return ErrorType.SERVER_ERROR;
  }

  /**
   * Create a structured success response
   */
  static createSuccess<T>(
    code: SuccessCode,
    data: T,
    requestId?: string,
    responseTime?: number
  ): SuccessResponse<T> {
    return {
      success: true,
      status: this.getSuccessStatusCode(),
      responseTime: responseTime || 0,
      code,
      data,
      timestamp: new Date().toISOString(),
      requestId
    };
  }

  /**
   * Parse error from scraper or other sources and convert to structured format
   */
  static parseError(error: any, requestId?: string, responseTime?: number): ErrorResponse {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Check for specific error patterns
    if (errorMessage.includes('Could not find calendar')) {
      return this.createError(
        ErrorCode.CALENDAR_NOT_FOUND,
        'Calendar elements not found on the page',
        'The scraper could not locate the calendar component. This may indicate the page structure has changed or the form is not loading correctly.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    if (errorMessage.includes('has been closed') || errorMessage.includes('Target page')) {
      return this.createError(
        ErrorCode.BROWSER_ERROR,
        'Browser connection lost',
        'The browser instance was closed or disconnected during scraping. This may be due to resource constraints or network issues.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    if (errorMessage.includes('timeout')) {
      return this.createError(
        ErrorCode.OPERATION_TIMEOUT,
        'Scraping operation timed out',
        'The scraping operation exceeded the maximum allowed time. The target site may be slow or unresponsive.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    if (errorMessage.includes('queue is full')) {
      return this.createError(
        ErrorCode.QUEUE_FULL,
        'Request queue is full',
        'The system is currently processing too many requests. Please try again later.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    // Time slot not found error
    if (errorMessage.includes('Time slot button not found') || errorMessage.includes('Time slot not found')) {
      return this.createError(
        ErrorCode.SLOT_NOT_FOUND,
        'Time slot not found',
        'The requested time slot could not be found on the calendar. The slot may have been booked by another user, or the time format may not match.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    // Day button not found error
    if (errorMessage.includes('Day button not found') || errorMessage.includes('day button not found')) {
      return this.createError(
        ErrorCode.DAY_BUTTON_NOT_FOUND,
        'Day button not found',
        'The requested date could not be found on the calendar. The date may be outside the available range or the calendar may not have loaded correctly.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }

    // Calendly booking: stream/controller closed (e.g. video save after context close)
    if (errorMessage.includes('Controller is already closed')) {
      return this.createError(
        ErrorCode.BROWSER_ERROR,
        'Browser or stream connection closed',
        'The booking session ended unexpectedly (e.g. video or connection closed). The booking may have completed; check your calendar.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }

    // Calendly: form element not clickable (overlay intercepts)
    if (errorMessage.includes('intercepts pointer events')) {
      return this.createError(
        ErrorCode.SCRAPING_FAILED,
        'Form element blocked',
        'A page overlay blocked the booking form. This can happen when the cookie banner or another dialog is still visible. Please try again.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }

    // Calendly: Schedule Event button or confirmation
    if (errorMessage.includes('Schedule Event button not found') || errorMessage.includes('Confirmation page did not load')) {
      return this.createError(
        ErrorCode.SCRAPING_FAILED,
        'Booking form or confirmation failed',
        'The booking could not be completed. The slot may no longer be available, or a required field may be missing.',
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    // Generic scraping error
    if (errorMessage.includes('Scraping') || errorMessage.includes('scrape')) {
      return this.createError(
        ErrorCode.SCRAPING_FAILED,
        'Scraping operation failed',
        errorMessage,
        { originalError: errorMessage },
        requestId,
        responseTime
      );
    }
    
    // Default to internal error
    return this.createError(
      ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred',
      errorMessage,
      { originalError: errorMessage },
      requestId,
      responseTime
    );
  }
}

