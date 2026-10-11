# AuroHear Project Structure

## Overview

AuroHear follows a clean, modular architecture with clear separation between frontend, backend, documentation, and testing components.

## Directory Structure

```
aurohear/
├── app.py                          # Main Flask application entry point
├── requirements.txt                # Python dependencies
├── package.json                    # Node.js dependencies
├── Dockerfile                      # Container configuration
├── procfile                        # Heroku/Render deployment
├── .env                           # Environment variables (not in git)
├── .env.example                   # Environment template
├── .gitignore                     # Git ignore rules
│
├── backend/                       # Backend Python modules
│   ├── __init__.py
│   ├── config.py                  # Configuration management
│   ├── database.py                # Database initialization
│   ├── migrate_db.py              # Database migration script
│   ├── users.db                   # SQLite database (development)
│   ├── instance/                  # Database instance files
│   │
│   ├── models/                    # Database models
│   │   ├── __init__.py
│   │   ├── user.py                # User model
│   │   ├── feedback.py            # Feedback model
│   │   ├── nlp_insights.py        # NLP insights model
│   │   └── screening_sessions.py  # Test sessions model
│   │
│   ├── routes/                    # Flask route blueprints
│   │   ├── __init__.py
│   │   ├── main.py                # Main page routes
│   │   ├── auth.py                # Authentication routes
│   │   ├── test.py                # Audiometric test routes
│   │   ├── feedback.py            # Feedback submission routes
│   │   └── nlp.py                 # NLP analysis routes
│   │
│   ├── utils/                     # Utility functions
│   │   ├── __init__.py
│   │   ├── audio.py               # Audio processing utilities
│   │   ├── algorithms.py          # Audiometric algorithms
│   │   └── helpers.py             # General helper functions
│   │
│   └── nlp_engine/                # NLP processing module
│       ├── __init__.py
│       ├── feedback_analyzer.py   # Core NLP analysis
│       └── store_results.py       # NLP results storage
│
├── static/                        # Frontend static files
│   ├── styles.css                 # Main application styles
│   ├── auth_styles.css            # Authentication-specific styles
│   └── script.js                  # Application JavaScript
│
├── templates/                     # HTML templates
│   └── index.html                 # Single-page application template
│
├── tests/                         # Test suite
│   ├── test_nlp_integration.py    # NLP engine tests
│   ├── test_feedback_nlp_integration.py  # End-to-end tests
│   ├── test_history_endpoint.py   # History API tests
│   ├── test_interaural_analysis.py # Analysis tests
│   ├── test_trend_analysis.py     # Trend analysis tests
│   └── test_educational_summary.py # Summary tests
│
├── docs/                          # Documentation
│   ├── README.md                  # Main project documentation
│   ├── DEPLOYMENT.md              # Deployment guide
│   ├── PROJECT_STRUCTURE.md       # This file
│   ├── NLP_RELIABILITY_MODULE.md  # NLP module documentation
│   ├── NLP_ARCHITECTURE_DIAGRAM.md # Architecture diagrams
│   ├── SUPABASE_NLP_SETUP.md      # Database setup guide
│   │
│   └── sql/                       # SQL scripts
│       └── supabase_nlp_table.sql # NLP table creation script
│
├── .github/                       # GitHub configuration
│   └── workflows/
│       └── keep-supabase-warm.yml # Deployment monitoring
│
├── .kiro/                         # Kiro IDE configuration
│   ├── steering/                  # Project guidelines
│   └── specs/                     # Feature specifications
│
└── node_modules/                  # Node.js dependencies (auto-generated)
```

## Architecture Principles

### 1. Separation of Concerns
- **Backend**: Pure Python logic, API endpoints, database operations
- **Frontend**: HTML/CSS/JavaScript for user interface
- **Documentation**: Comprehensive guides and API documentation
- **Testing**: Isolated test suites for each component

### 2. Modular Design
- **Models**: Database entities with clear relationships
- **Routes**: Blueprint-based URL routing with logical grouping
- **Utils**: Reusable utility functions and algorithms
- **NLP Engine**: Isolated natural language processing module

### 3. Clean Imports
```python
# ✅ Good: Clear module imports
from backend.models import User, TestFeedback
from backend.routes.auth import auth_bp
from backend.utils.audio import generate_tone

# ❌ Avoid: Monolithic imports
from app import *
```

### 4. Configuration Management
- Environment-based configuration (dev/prod/test)
- Centralized settings in `backend/config.py`
- Secure credential handling via environment variables

## Component Responsibilities

### Backend Components

#### `backend/config.py`
- Environment variable management
- Database URL configuration
- Supabase client setup
- Development/production settings

#### `backend/database.py`
- SQLAlchemy initialization
- Database connection management
- Supabase client initialization
- Table creation utilities

#### `backend/models/`
- **user.py**: User profiles and authentication
- **feedback.py**: User feedback and ratings
- **nlp_insights.py**: NLP analysis results
- **screening_sessions.py**: Audiometric test data

#### `backend/routes/`
- **main.py**: Homepage and basic navigation
- **auth.py**: User registration and authentication
- **test.py**: Audiometric testing endpoints
- **feedback.py**: Feedback submission and retrieval
- **nlp.py**: NLP analysis and insights

#### `backend/utils/`
- **audio.py**: Audio generation and processing
- **algorithms.py**: Hughson-Westlake and reliability algorithms
- **helpers.py**: General utility functions

#### `backend/nlp_engine/`
- **feedback_analyzer.py**: Core NLP processing
- **store_results.py**: Database integration for NLP results

### Frontend Components

#### `static/script.js`
- Single-page application logic
- Audio playback management
- Test state management
- API communication
- User interface interactions

#### `static/styles.css`
- Responsive design system
- Glass morphism effects
- Professional medical interface
- Accessibility compliance

#### `templates/index.html`
- Single-page application template
- Progressive enhancement
- Semantic HTML structure

### Documentation Structure

#### Core Documentation
- **README.md**: Project overview and quick start
- **DEPLOYMENT.md**: Production deployment guide
- **PROJECT_STRUCTURE.md**: Architecture documentation

#### NLP Module Documentation
- **NLP_RELIABILITY_MODULE.md**: Complete module specification
- **NLP_ARCHITECTURE_DIAGRAM.md**: Visual architecture diagrams
- **SUPABASE_NLP_SETUP.md**: Database setup instructions

#### SQL Scripts
- **supabase_nlp_table.sql**: NLP table creation and setup

## Development Workflow

### 1. Local Development
```bash
# Setup
python -m venv venv
source venv/bin/activate  # Unix/Mac
venv\Scripts\activate     # Windows

# Install dependencies
pip install -r requirements.txt
npm install

# Run application
python app.py
```

### 2. Database Management
```bash
# Initialize database
python backend/migrate_db.py

# Reset database (development)
rm backend/users.db
python backend/migrate_db.py
```

### 3. Testing
```bash
# Run all tests
python -m pytest tests/

# Run specific test
python tests/test_nlp_integration.py
```

### 4. Code Organization
- Follow PEP 8 for Python code
- Use ESLint standards for JavaScript
- Maintain clear module boundaries
- Document all public APIs

## Deployment Structure

### Development
- SQLite database in `backend/users.db`
- Local file-based configuration
- Debug mode enabled

### Production
- PostgreSQL database via Supabase
- Environment-based configuration
- Gunicorn WSGI server
- Docker containerization

## Benefits of This Structure

1. **Maintainability**: Clear separation makes code easier to understand and modify
2. **Scalability**: Modular design allows for easy feature additions
3. **Testing**: Isolated components enable comprehensive testing
4. **Collaboration**: Clear structure helps team members navigate the codebase
5. **Deployment**: Organized structure simplifies deployment and CI/CD

## Migration from Old Structure

The previous monolithic `app.py` has been refactored into:
- Configuration → `backend/config.py`
- Models → `backend/models/*.py`
- Routes → `backend/routes/*.py`
- Utilities → `backend/utils/*.py`
- Tests → `tests/*.py`
- Documentation → `docs/*.md`

This provides a much cleaner, more maintainable codebase while preserving all existing functionality.