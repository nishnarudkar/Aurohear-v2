# AuroHear

**Professional web-based hearing asymmetry screening platform**

[![Python](https://img.shields.io/badge/Python-3.10+-blue?style=flat-square&logo=python)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-2.3+-green?style=flat-square&logo=flask)](https://flask.palletsprojects.com)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-yellow?style=flat-square&logo=javascript)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

AuroHear provides preliminary audiometric testing at standard frequencies (250-5000 Hz) using adaptive algorithms to identify significant interaural differences (≥20 dB) that may indicate hearing asymmetries.

> **Medical Disclaimer**: This is a screening tool only - not a diagnostic instrument. All results require professional audiological interpretation.

## Features

- **Adaptive Audiometry**: Hughson-Westlake algorithms with catch trials for reliability assessment
- **Standard Testing**: Complete frequency range (250-5000 Hz) with precise dB HL mapping
- **User Management**: Supabase authentication with privacy-focused guest mode
- **Interactive Reports**: Professional PDF/PNG exports with audiogram visualizations
- **Response Analytics**: Reliability scoring and interaural difference analysis
- **Modern Interface**: Responsive design with accessibility compliance

## Quick Start

### Prerequisites
- Python 3.10+ with pip
- Node.js 16+ (for frontend dependencies)
- Supabase account (for authentication and database)

### Installation

```bash
# Clone and setup
git clone <repository-url>
cd audiometry-test
python -m venv venv

# Activate environment
venv\Scripts\activate          # Windows
source venv/bin/activate       # Unix/Mac

# Install dependencies
pip install -r requirements.txt
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Supabase credentials

# Initialize database
python migrate_db.py

# Run application
python app.py
```

Visit `http://127.0.0.1:5000` to access the application.

## Configuration

### Environment Variables
```env
DATABASE_URL="postgresql://user:pass@host:port/db"  # Optional, SQLite fallback
SUPABASE_URL="https://your-project.supabase.co"    # Required
SUPABASE_KEY="your-anon-key"                       # Required
```

### Database Schema
- **`user`**: User profiles and aggregated test results
- **`screening_sessions`**: Detailed frequency-specific test data
- **`test_feedback`**: User feedback for platform improvement

## Deployment

### Docker
```bash
docker build -t aurohear .
docker run -p 10000:10000 --env-file .env aurohear
```

### Platform Deployment
- **Render**: Connect repository, set environment variables, use `gunicorn app:app --bind 0.0.0.0:$PORT`
- **Heroku**: Standard Python deployment with Procfile
- **Manual**: `gunicorn app:app --bind 0.0.0.0:10000 --workers 4`

**Production Requirements**: SSL certificate, PostgreSQL database, environment variables configured

## Architecture

### Technology Stack
- **Backend**: Flask + SQLAlchemy, NumPy/SciPy for audio processing
- **Frontend**: Vanilla JavaScript ES6+, Chart.js for visualizations
- **Database**: PostgreSQL (Supabase) with SQLite fallback
- **Authentication**: Supabase Auth with guest mode support
- **Audio**: Web Audio API with server-generated WAV files

### Key API Endpoints
- `/start_test` - Initialize hearing test
- `/submit_response` - Process test responses  
- `/next_test` - Get next test parameters
- `/tone` - Generate audio tones
- `/save_results` - Save aggregated results
- `/submit_feedback` - Submit user feedback

## Usage

### Testing Workflow
1. **Authentication**: Sign up/in for full features or use guest mode for privacy
2. **Device Setup**: Headphone verification and volume calibration
3. **Automated Testing**: 6 frequencies per ear with adaptive threshold detection
4. **Results**: Interactive audiogram with reliability assessment and professional reports

### Features
- **Authenticated Users**: Test history, trend analysis, data export
- **Guest Mode**: Complete privacy, no data storage
- **Feedback System**: Required post-test ratings and suggestions for NLP analysis

## Medical Disclaimers

**This is a preliminary screening tool only - NOT a diagnostic instrument**

- Results cannot diagnose hearing loss or medical conditions
- Professional audiological interpretation required for all results
- Environmental factors and equipment quality affect accuracy
- Not validated for pediatric populations
- Seek professional help for sudden hearing changes, tinnitus, or hearing concerns

## Development

### Project Structure
```
audiometry-test/
├── app.py                          # Main Flask application
├── migrate_db.py                   # Database migration utilities
├── static/
│   ├── styles.css                  # Main application styles
│   ├── auth_styles.css            # Authentication-specific styles
│   └── script.js                  # Frontend JavaScript application
├── templates/
│   └── index.html                 # Single-page application template
├── instance/
│   └── users.db                   # SQLite database (development)
├── .github/workflows/
│   └── keep-supabase-warm.yml     # CI/CD and maintenance
├── test_*.py                      # Test files
├── requirements.txt               # Python dependencies
├── package.json                   # Node.js dependencies
├── Dockerfile                     # Container configuration
├── procfile                       # Heroku/Render deployment
├── .env.example                   # Environment template
├── DEPLOYMENT.md                  # Detailed deployment guide
└── LICENSE                        # MIT License
```

### Development Commands
```bash
# Setup
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt && npm install

# Run
python app.py              # Development server
python migrate_db.py       # Database setup
python -m pytest tests/   # Run tests
```

## Technical Specifications

### Audio Processing
- **Sample Rate**: 44.1 kHz, 16-bit stereo
- **Frequency Range**: 250-5000 Hz (standard audiometric frequencies)
- **Algorithm**: Modified Hughson-Westlake with catch trials
- **Reliability**: Response consistency scoring with catch trial validation

### NLP Reliability Module
- **Purpose**: Automated feedback analysis for platform improvement
- **Models**: DistilBERT (sentiment), RoBERTa (emotions), custom rules (issues)
- **Processing**: Real-time analysis with Supabase storage
- **Ethics**: Complete separation from audiometric results - no clinical influence
- **Privacy**: Anonymous analysis, aggregated insights only

### Performance
- **Test Duration**: 8-12 minutes complete assessment
- **Browser Support**: Chrome 80+, Firefox 75+, Safari 13+, Edge 80+
- **Accuracy**: ±5 dB compared to clinical audiometry in controlled settings

## Documentation

### Core Platform
- **[README.md](README.md)** - Main project documentation
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Production deployment guide
- **[SUPABASE_NLP_SETUP.md](SUPABASE_NLP_SETUP.md)** - Database setup for NLP features

### NLP Reliability Module
- **[NLP_RELIABILITY_MODULE.md](NLP_RELIABILITY_MODULE.md)** - Complete module documentation
  - System purpose and objectives
  - Data flow architecture
  - Database schema design
  - Ethical constraints and safeguards
  - Future expansion roadmap
- **[NLP_ARCHITECTURE_DIAGRAM.md](NLP_ARCHITECTURE_DIAGRAM.md)** - Visual system architecture
  - Component interaction diagrams
  - Security boundaries
  - Deployment architecture
  - Scaling strategies

### Testing & Integration
- **[test_nlp_integration.py](test_nlp_integration.py)** - NLP engine testing
- **[test_feedback_nlp_integration.py](test_feedback_nlp_integration.py)** - End-to-end integration testing

## Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/name`)
3. Follow PEP 8 (Python) and ESLint (JavaScript) standards
4. Add tests and update documentation
5. Submit pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**AuroHear** - Professional hearing screening platform for educational and preliminary assessment purposes only. Always consult healthcare professionals for medical advice.