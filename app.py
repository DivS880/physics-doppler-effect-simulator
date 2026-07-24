
from flask import Flask, jsonify, request

# Serve the existing frontend files (index.html, styles.css, script.js)
# directly from this same folder, so no separate static server is needed.
app = Flask(__name__, static_folder='.', static_url_path='')

DEFAULT_SPEED_OF_SOUND = 343


def freq_ahead(f, v, vs):
    if v - vs <= 0:
        return None  # represents Infinity (JSON has no Infinity)
    return f * v / (v - vs)


def freq_behind(f, v, vs):
    return f * v / (v + vs)


def wavelength(speed, freq):
    if freq is None or freq <= 0:
        return 0
    return speed / freq


def lambda_source(v, f):
    return v / f


def lambda_front(v, vs, f):
    if v - vs <= 0:
        return 0
    return (v - vs) / f


def lambda_rear(v, vs, f):
    return (v + vs) / f


def mach(vs, v):
    return vs / v


# ---- Routes ----------------------------------------------------------

@app.route('/')
def index():
    return app.send_static_file('index.html')


@app.route('/api/doppler', methods=['POST'])
def api_doppler():

    data = request.get_json(force=True) or {}
    f = float(data.get('frequency', 440))
    vs = float(data.get('speed', 0))
    v = float(data.get('speedOfSound', DEFAULT_SPEED_OF_SOUND))

    fA = freq_ahead(f, v, vs)
    fB = freq_behind(f, v, vs)

    result = {
        'freqAhead': fA,
        'freqBehind': fB,
        'wavelengthAhead': wavelength(v, fA) if fA is not None else None,
        'wavelengthBehind': wavelength(v, fB),
        'lambdaSource': lambda_source(v, f),
        'lambdaFront': lambda_front(v, vs, f),
        'lambdaRear': lambda_rear(v, vs, f),
        'mach': mach(vs, v),
    }
    return jsonify(result)


@app.route('/api/doppler-curve', methods=['POST'])
def api_doppler_curve():

    data = request.get_json(force=True) or {}
    f = float(data.get('frequency', 440))
    v = float(data.get('speedOfSound', DEFAULT_SPEED_OF_SOUND))
    max_vs = float(data.get('maxVs', 100))
    steps = int(data.get('steps', 200))

    points = []
    for i in range(steps + 1):
        vs = (i / steps) * max_vs
        fA = freq_ahead(f, v, vs)
        fB = freq_behind(f, v, vs)
        points.append({'vs': vs, 'freqAhead': fA, 'freqBehind': fB})

    return jsonify({'points': points})


if __name__ == '__main__':
    app.run(debug=True, port=5000)
